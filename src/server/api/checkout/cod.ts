import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../../db'
import { Order, OrderItem, Payment, User } from '../../db/schema'
import { authenticate } from '@/server/middlewares'
import { processFoodOrder } from './common'

// Create a COD router
export const codRoutes = new Hono()

// Cash on Delivery checkout
codRoutes.post('/cod', authenticate, async (c) => {
  try {
    const { items, deliveryAddress, totalAmount, paymentMethod } = await c.req.json()

    if (!items || !Array.isArray(items) || items.length === 0) {
      return c.json({ error: 'Items are required' }, 400)
    }

    if (!deliveryAddress || !deliveryAddress.qrno) {
      return c.json({ error: 'Delivery address is required' }, 400)
    }

    if (!totalAmount || totalAmount <= 0) {
      return c.json({ error: 'Valid total amount is required' }, 400)
    }

    // Get user ID from context
    const user = c.get('user') as any
    const userId = user?.id

    // Process food order using common function
    const result = await processFoodOrder(
      items,
      deliveryAddress,
      totalAmount,
      paymentMethod || 'COD',
      userId
    )

    return c.json({
      success: true,
      orderNo: result.orderNo, // Customer-facing order number
      paymentId: result.paymentId, // Shared payment ID for all orders
      orders: result.orders,
      message: `${result.orders.length} order(s) created and pending payment confirmation`,
      thankYouMessage: 'Thank you for ordering with HomeFood!',
      orderSummary: result.orderSummary, // Summary of all items grouped by host
    })
  } catch (error: any) {
    console.error('COD checkout error:', error)
    return c.json({ error: error.message || 'COD checkout failed' }, error.status || 500)
  }
})

// Payment success endpoint - updates all orders for a payment
codRoutes.post('/payment-success', async (c) => {
  try {
    const { paymentId, paymentReferenceId } = await c.req.json()

    if (!paymentId) return c.json({ error: 'paymentId is required' }, 400)

    // Update payment status to paid
    await db
      .update(Payment)
      .set({
        paymentStatus: 'paid',
        paymentReferenceId: paymentReferenceId || null,
        updatedAt: new Date(),
      })
      .where(eq(Payment.id, paymentId))

    // Find all orders with this paymentId
    const ordersToUpdate = await db.query.Order.findMany({
      where: eq(Order.paymentId, paymentId),
    })

    // Update all orders to confirmed and paid status
    const updatedOrders = []
    for (const order of ordersToUpdate) {
      await db
        .update(Order)
        .set({
          status: 'confirmed',
          paymentStatus: 'paid',
          updatedAt: new Date(),
        })
        .where(eq(Order.id, order.id))

      // Fetch the updated order with items
      const updatedOrder = await db.query.Order.findFirst({
        where: eq(Order.id, order.id),
      })

      // Fetch order items
      const orderItems = await db.query.OrderItem.findMany({
        where: eq(OrderItem.orderId, order.id),
      })

      // Fetch host name
      const host = await db.query.User.findFirst({
        where: eq(User.id, updatedOrder?.hostId || ''),
        columns: { name: true },
      })

      // Extract base order number - only split if there's a suffix (multiple vendors)
      const orderNumber = updatedOrder?.orderNumber || ''
      const hasSuffix = orderNumber.includes('-')
      const baseOrderNumber = hasSuffix
        ? orderNumber.split('-').slice(0, -1).join('-')
        : orderNumber

      updatedOrders.push({
        orderId: updatedOrder?.id,
        orderNo: baseOrderNumber, // Extract base order number only if suffixed
        parentOrderNo: updatedOrder?.orderNumber,
        paymentId: updatedOrder?.paymentId,
        hostId: updatedOrder?.hostId,
        hostName: host?.name || 'Unknown Host', // Add host name
        totalAmount: updatedOrder?.totalAmount,
        status: updatedOrder?.status,
        paymentStatus: updatedOrder?.paymentStatus,
        estimatedDelivery: '6:00 PM - 9:30 PM',
        items: orderItems,
      })
    }

    return c.json({
      success: true,
      message: `${updatedOrders.length} order(s) confirmed and marked as paid`,
      paymentId,
      orders: updatedOrders,
    })
  } catch (error: any) {
    console.error('Payment success error:', error)
    return c.json({ error: error.message || 'Payment success update failed' }, error.status || 500)
  }
})
