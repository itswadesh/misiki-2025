import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../../db'
import { Order } from '../../db/schema'
import { afterOrderConfirmation, placeOrder } from './utils'
import { validateCoupon as validateCouponUtil } from './validate-coupon'

// Create a RevenueCat router
export const revenuecatRoutes = new Hono()

// Format phone number
function parsePhoneNumber(phone: string): string {
  phone = phone.replace(/\s/g, '')
  if (!phone.startsWith('+')) {
    if (phone.length === 10) {
      phone = `+91${phone}`
    }
  }
  return phone
}

// RevenueCat checkout (create order before RC purchase)
revenuecatRoutes.post('/checkout/revenuecat', async (c) => {
  try {
    const { total_amount, plan_id, phone, couponCode, user_id } = await c.req.json()
    let finalAmount = total_amount
    if (couponCode && plan_id) {
      try {
        const couponData = await validateCouponUtil({ couponCode, planId: plan_id })
        finalAmount = couponData
      } catch (couponError: any) {
        console.warn(`Coupon ${couponCode} validation failed: ${couponError.message}`)
      }
    }

    const newOrder = await placeOrder({
      pgName: 'RevenueCat',
      totalAmount: finalAmount,
      planId: plan_id,
      phone: phone ? parsePhoneNumber(phone) : undefined,
      couponCode: couponCode,
      userId: user_id,
    })
    return c.json({
      order_no: newOrder.id,
      plan_id: newOrder.planId,
      plan_price: newOrder.totalAmount,
      message: 'Order created for RevenueCat purchase.',
    })
  } catch (error: any) {
    console.error('RevenueCat order creation error:', error)
    return c.json(
      { error: error.message || 'RevenueCat order creation failed' },
      error.status || 500
    )
  }
})

// RevenueCat capture (webhook or client confirmation)
revenuecatRoutes.post('/checkout/revenuecat-capture', async (c) => {
  try {
    const { order_no, payment_reference_id, amount_paid, phone, email } = await c.req.json()
    if (!order_no) return c.json({ error: 'order_no is required' }, 400)
    if (!payment_reference_id) return c.json({ error: 'Payment reference ID is required' }, 400)

    const order = await db.query.Order.findFirst({
      where: and(eq(Order.id, order_no), eq((Order as any).pgName, 'RevenueCat')),
    })
    if (!order) return c.json({ error: `RevenueCat order ${order_no} not found` }, 404)
    // Optionally: if (order.user_id !== user_id) return c.json({ error: 'User ID mismatch' }, 403);

    const confirmedOrder = await afterOrderConfirmation({
      order,
      amount_paid,
      payment_status: 'PAID',
      payment_reference_id,
      pg_name: 'RevenueCat',
      phone: phone ? parsePhoneNumber(phone) : (order as any).phone,
      email: email || (order as any).email,
    })
    return c.json({
      order_no: confirmedOrder.id,
      plan_id: confirmedOrder.planId,
      plan_price: (confirmedOrder as any).totalAmount,
      message: 'RevenueCat purchase confirmed.',
    })
  } catch (error: any) {
    console.error('RevenueCat capture error:', error)
    return c.json({ error: error.message || 'RevenueCat capture failed' }, error.status || 500)
  }
})
