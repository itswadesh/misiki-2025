import { zValidator } from '@hono/zod-validator'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import Stripe from 'stripe'
import { db } from '../../db'
import { Order, OrderItem, Product, Payment, User } from '../../db/schema' // Coupon schema might be needed if validateCouponUtil returns full Coupon object
import { afterOrderConfirmation, placeOrder } from './utils' // Assuming placeOrder is in utils
import { capturePhonepe } from './phonepe/capture'
import { phonepeCheckout } from './phonepe/checkout'
import { validateCoupon as validateCouponUtil } from './validate-coupon'
import { authenticate } from '@/server/middlewares'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// Create a checkout router
export const checkoutRoutes = new Hono()

// Validation schema for the PhonePe checkout request
const phonepeCheckoutSchema = z.object({
  plan_id: z.string().min(1, 'Plan ID is required'),
  phone: z.string().min(10, 'Valid phone number is required').max(13),
  total_amount: z.number().min(1, 'Amount must be at least 1'),
  couponCode: z.string().optional(),
  origin: z.string().optional(),
})

// Validator middleware
const validatePhonepeCheckout = zValidator('json', phonepeCheckoutSchema)

// Validation schema for Stripe Billie checkout
const stripeBillieCheckoutSchema = z.object({
  plan_id: z.string().min(1, 'Plan ID is required'),
  total_amount: z.number().min(1, 'Amount must be at least 1'),
  couponCode: z.string().optional(),
  billing_details: z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Valid email is required'),
    address: z.object({
      line1: z.string().min(1, 'Address line 1 is required'),
      line2: z.string().optional(),
      city: z.string().min(1, 'City is required'),
      state: z.string().min(1, 'State is required'),
      postal_code: z.string().min(1, 'Postal code is required'),
      country: z.string().min(2, 'Country is required').max(2, 'Country must be 2 letters'),
    }),
  }),
})

// Validator middleware
const validateStripeBillieCheckout = zValidator('json', stripeBillieCheckoutSchema)

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

// PhonePe checkout endpoint
checkoutRoutes
  .post('/phonepe', validatePhonepeCheckout, async (c) => {
    try {
      const { plan_id, phone, total_amount, couponCode, origin } = await c.req.json()
      const newOrder = await phonepeCheckout({
        pg_name: 'Phonepe',
        totalAmount: total_amount,
        planId: plan_id,
        phone: parsePhoneNumber(phone),
        couponCode,
        origin,
      })
      return c.json(newOrder, 200)
    } catch (e: any) {
      // console.error('PhonePe checkout error:.', e)
      return c.json({ error: e.message || 'PhonePe checkout failed' }, e.status || 500)
    }
  })
  .get('/phonepe-capture', async (c) => {
    try {
      const { order_no, origin, pg_name } = c.req.query()
      if (!order_no) {
        return c.json({ error: 'order_no is required' }, 400)
      }
      // capturePhonepe is expected to handle the response (e.g., redirect or JSON)
      await capturePhonepe({ c, order_no, origin, pg_name })
    } catch (e: any) {
      console.error('PhonePe capture error:', e)
      return c.json({ error: e.message || 'PhonePe capture failed' }, e.status || 500)
    }
  })

// Validate coupon endpoint
checkoutRoutes.post('/validate-coupon', async (c) => {
  try {
    const { couponCode, plan_id } = await c.req.json()
    if (!couponCode) return c.json({ error: 'Coupon code is required' }, 400)
    if (!plan_id) return c.json({ error: 'Plan ID is required' }, 400)

    const validationResult = await validateCouponUtil({ couponCode, planId: plan_id })
    return c.json({
      success: true,
      data: validationResult,
    })
  } catch (error: any) {
    console.error('Coupon validation error:', error)
    return c.json(
      {
        success: false,
        error: error.message || 'Failed to validate coupon',
      },
      error.status || 500
    )
  }
})

// Verify payment status
checkoutRoutes.get('/verify/:orderId', async (c) => {
  try {
    const orderId = c.req.param('orderId')
    const order = await db.query.Order.findFirst({
      where: eq(Order.id, orderId),
    })
    if (!order) return c.json({ error: 'Order not found' }, 404)
    return c.json({
      orderId: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      isPaid: !!order.isPaid,
    })
  } catch (error: any) {
    console.error('Payment verification error:', error)
    return c.json({ error: error.message || 'An unknown error occurred' }, error.status || 500)
  }
})

// Webhook for PhonePe
checkoutRoutes.post('/webhook/phonepe', async (c) => {
  try {
    const data = await c.req.json()
    // TODO: Add actual PhonePe signature verification logic here
    const { merchantTransactionId, status, amount, providerReferenceId } = data.data // Adjust path based on actual payload
    const orderId = merchantTransactionId

    if (!orderId) return c.json({ error: 'Order ID (merchantTransactionId) missing' }, 400)

    const order = await db.query.Order.findFirst({ where: eq(Order.id, orderId) })
    if (!order) return c.json({ error: `Order ${orderId} not found` }, 404)

    let paymentStatusInternal = 'PENDING'
    if (status === 'PAYMENT_SUCCESS') paymentStatusInternal = 'PAID'
    else if (['PAYMENT_ERROR', 'TIMED_OUT', 'PAYMENT_DECLINED'].includes(status))
      paymentStatusInternal = 'FAILED'

    await afterOrderConfirmation({
      order,
      amount_paid: amount, // Amount from PhonePe might be in paise
      paymentStatus: paymentStatusInternal,
      payment_reference_id: providerReferenceId,
      pg_name: 'Phonepe',
    })
    return c.json({ success: true, message: 'Webhook processed' })
  } catch (error: any) {
    console.error('PhonePe webhook error:', error)
    return c.json(
      { success: false, error: error.message || 'Webhook processing failed' },
      200 // Acknowledge receipt to PhonePe
    )
  }
})

// Simulate payment completion (for testing)
checkoutRoutes.post('/simulate-payment', async (c) => {
  try {
    const { orderId, status = 'SUCCESS' } = await c.req.json()
    if (!orderId) return c.json({ error: 'orderId is required' }, 400)

    const order = await db.query.Order.findFirst({ where: eq(Order.id, orderId) })
    if (!order) return c.json({ error: `Order ${orderId} not found` }, 404)

    await afterOrderConfirmation({
      order,
      amount_paid: order.totalAmount,
      paymentStatus: status === 'SUCCESS' ? 'PAID' : 'FAILED',
      payment_reference_id: `simulated_${nanoid()}`,
      pg_name: 'Simulation',
    })
    return c.json({ success: true, message: `Payment for order ${orderId} simulated as ${status}` })
  } catch (error: any) {
    console.error('Payment simulation error:', error)
    return c.json({ error: error.message || 'An unknown error occurred' }, error.status || 500)
  }
})

// Razorpay checkout
checkoutRoutes.post('/checkout/razorpay', async (c) => {
  try {
    const { total_amount, plan_id, phone, couponCode } = await c.req.json()
    let finalAmount = total_amount
    if (couponCode && plan_id) {
      try {
        const couponData = await validateCouponUtil({ couponCode, planId: plan_id })
        finalAmount = couponData.finalPrice
      } catch (couponError: any) {
        console.warn(`Coupon ${couponCode} validation failed: ${couponError.message}`)
      }
    }

    const newOrder = await placeOrder({
      pgName: 'Razorpay',
      totalAmount: finalAmount,
      planId: plan_id,
      phone: phone ? parsePhoneNumber(phone) : undefined,
      couponCode: couponCode,
    })

    const razorpayInstance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    })

    const rzOrder = await razorpayInstance.orders.create({
      amount: newOrder.total_amount * 100, // Amount in paise
      currency: 'INR',
      receipt: newOrder.id.toString(),
      notes: { plan_id: newOrder.plan_id },
    })

    await db.update(Order).set({ payment_order_id: rzOrder.id }).where(eq(Order.id, newOrder.id))

    return c.json({
      key_id: process.env.RAZORPAY_KEY_ID,
      order_id: rzOrder.id,
      amount: rzOrder.amount,
      name: 'Misiki Checkout',
      description: `Order ${newOrder.id}`,
      receipt_db_order_id: newOrder.id,
    })
  } catch (error: any) {
    console.error('Razorpay checkout error:', error)
    return c.json({ error: error.message || 'Razorpay checkout failed' }, error.status || 500)
  }
})

// Razorpay capture
checkoutRoutes.post('/checkout/razorpay-capture', async (c) => {
  let db_order_id_for_error_handling: string | undefined
  try {
    const args = await c.req.json()
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, receipt_db_order_id } = args
    db_order_id_for_error_handling = receipt_db_order_id

    // TODO: Verify Razorpay signature
    // import crypto from 'crypto';
    // const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!];
    // shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    // if (shasum.digest('hex') !== razorpay_signature) return c.json({ error: 'Invalid signature' }, 400);

    const order = await db.query.Order.findFirst({
      where: and(eq(Order.id, receipt_db_order_id), eq(Order.payment_order_id, razorpay_order_id)),
    })
    if (!order)
      return c.json({ error: `Order ${receipt_db_order_id} not found or ID mismatch` }, 404)

    const razorpayInstance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    })
    const paymentDetails = await razorpayInstance.payments.fetch(razorpay_payment_id)

    if (paymentDetails.status !== 'captured' && paymentDetails.status !== 'authorized') {
      await afterOrderConfirmation({
        order,
        amount_paid: 0,
        payment_status: 'FAILED',
        payment_reference_id: razorpay_payment_id,
        pg_name: 'Razorpay',
      })
      return c.json(
        { error: `Payment ${paymentDetails.status}`, payment_status: paymentDetails.status },
        400
      )
    }

    const confirmedOrder = await afterOrderConfirmation({
      order,
      amount_paid: paymentDetails.amount / 100,
      payment_status: 'PAID',
      payment_reference_id: razorpay_payment_id,
      pg_name: 'Razorpay',
      phone: paymentDetails.contact ? parsePhoneNumber(paymentDetails.contact) : order.phone,
      email: paymentDetails.email || order.email,
    })

    const planDetails = await db.query.Plan.findFirst({
      where: eq(Plan.id, confirmedOrder.plan_id),
    })
    return c.json({
      order_no: confirmedOrder.id,
      plan_id: confirmedOrder.plan_id,
      plan_price: planDetails?.price,
      message: 'Payment successful',
    })
  } catch (error: any) {
    console.error('Razorpay capture error:', error)
    if (db_order_id_for_error_handling) {
      const order = await db.query.Order.findFirst({
        where: eq(Order.id, db_order_id_for_error_handling),
      })
      if (order && order.payment_status !== 'PAID') {
        // Avoid overwriting a successful payment
        await afterOrderConfirmation({
          order,
          amount_paid: 0,
          payment_status: 'FAILED',
          payment_reference_id: (await c.req.json()).razorpay_payment_id,
          pg_name: 'Razorpay',
        })
      }
    }
    return c.json({ error: error.message || 'Razorpay capture failed' }, error.status || 500)
  }
})

// Stripe checkout - create PaymentIntent
checkoutRoutes.post('/stripe-checkout', async (c) => {
  try {
    const { plan_id, total_amount, couponCode, payment_method_type } = await c.req.json()
    let finalAmount = total_amount
    if (couponCode && plan_id) {
      try {
        const couponData = await validateCouponUtil({ couponCode, planId: plan_id })
        finalAmount = couponData.finalPrice
      } catch (couponError: any) {
        console.warn(`Coupon ${couponCode} validation failed: ${couponError.message}`)
      }
    }

    const newOrder = await placeOrder({
      pgName: 'Stripe',
      totalAmount: finalAmount,
      planId: plan_id,
      phone: undefined,
      couponCode: couponCode,
    })

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(finalAmount * 100), // Amount in cents
      currency: payment_method_type === 'billie' ? 'gbp' : 'usd', // Billie requires EUR, card can be USD
      payment_method_types: [payment_method_type],
      metadata: {
        order_id: newOrder.id,
        plan_id: newOrder.plan_id,
      },
    })

    return c.json({
      client_secret: paymentIntent.client_secret,
      order_id: newOrder.id,
    })
  } catch (error: any) {
    console.error('Stripe checkout error:', error)
    return c.json({ error: error.message || 'Stripe checkout failed' }, error.status || 500)
  }
})

// Stripe confirm payment
checkoutRoutes.post('/stripe-confirm', async (c) => {
  try {
    const { payment_intent_id, order_id } = await c.req.json()

    const order = await db.query.Order.findFirst({
      where: eq(Order.id, order_id),
    })
    if (!order) return c.json({ error: 'Order not found' }, 404)

    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id)

    if (paymentIntent.status === 'succeeded') {
      // Payment succeeded
      const confirmedOrder = await afterOrderConfirmation({
        order,
        amount_paid: paymentIntent.amount / 100,
        payment_status: 'PAID',
        payment_reference_id: paymentIntent.id,
        pg_name: 'Stripe Billie',
      })

      return c.json({
        success: true,
        order_no: confirmedOrder.id,
        message: 'Payment successful',
      })
    } else if (paymentIntent.status === 'requires_payment_method') {
      // Payment failed - requires new payment method
      await afterOrderConfirmation({
        order,
        amount_paid: 0,
        payment_status: 'FAILED',
        payment_reference_id: paymentIntent.id,
        pg_name: 'Stripe',
      })
      return c.json({ error: 'Payment failed - please try a different payment method', status: paymentIntent.status }, 400)
    } else if (paymentIntent.status === 'requires_action') {
      // Authentication required
      return c.json({
        requires_action: true,
        payment_intent_client_secret: paymentIntent.client_secret,
        status: paymentIntent.status
      })
    } else {
      // Other failure
      await afterOrderConfirmation({
        order,
        amount_paid: 0,
        payment_status: 'FAILED',
        payment_reference_id: paymentIntent.id,
        pg_name: 'Stripe',
      })
      return c.json({ error: 'Payment failed', status: paymentIntent.status }, 400)
    }
  } catch (error: any) {
    console.error('Stripe confirm error:', error)
    return c.json({ error: error.message || 'Stripe confirm failed' }, error.status || 500)
  }
})

// Stripe webhook
checkoutRoutes.post('/webhook/stripe', async (c) => {
  const sig = c.req.header('stripe-signature')
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET

  let event

  try {
    event = stripe.webhooks.constructEvent(await c.req.text(), sig!, endpointSecret!)
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return c.json({ error: 'Webhook signature verification failed' }, 400)
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object
      const orderId = paymentIntent.metadata.order_id

      if (!orderId) {
        console.error('No order_id in payment_intent metadata')
        return c.json({ error: 'No order_id in metadata' }, 400)
      }

      const order = await db.query.Order.findFirst({
        where: eq(Order.id, orderId),
      })

      if (!order) {
        console.error(`Order ${orderId} not found`)
        return c.json({ error: 'Order not found' }, 404)
      }

      // Fulfill the order
      await afterOrderConfirmation({
        order,
        amount_paid: paymentIntent.amount / 100,
        payment_status: 'PAID',
        payment_reference_id: paymentIntent.id,
        pg_name: 'Stripe',
      })

      console.log(`Order ${orderId} fulfilled via webhook`)
    } else if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object
      const orderId = paymentIntent.metadata.order_id

      if (orderId) {
        const order = await db.query.Order.findFirst({
          where: eq(Order.id, orderId),
        })

        if (order) {
          await afterOrderConfirmation({
            order,
            amount_paid: 0,
            payment_status: 'FAILED',
            payment_reference_id: paymentIntent.id,
            pg_name: 'Stripe',
          })
        }
      }
    }

    return c.json({ received: true })
  } catch (error: any) {
    console.error('Stripe webhook processing error:', error)
    return c.json({ error: error.message || 'Webhook processing failed' }, 500)
  }
})

// RevenueCat checkout (create order before RC purchase)
checkoutRoutes.post('/checkout/revenuecat', async (c) => {
  try {
    const { total_amount, plan_id, phone, couponCode, user_id } = await c.req.json()
    let finalAmount = total_amount
    if (couponCode && plan_id) {
      try {
        const couponData = await validateCouponUtil({ couponCode, planId: plan_id })
        finalAmount = couponData.finalPrice
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
      plan_id: newOrder.plan_id,
      plan_price: newOrder.total_amount,
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
checkoutRoutes.post('/checkout/revenuecat-capture', async (c) => {
  try {
    const { order_no, payment_reference_id, amount_paid, phone, email, user_id } =
      await c.req.json()
    if (!order_no) return c.json({ error: 'order_no is required' }, 400)
    if (!payment_reference_id) return c.json({ error: 'Payment reference ID is required' }, 400)

    const order = await db.query.Order.findFirst({
      where: and(eq(Order.id, order_no), eq(Order.pg_name, 'RevenueCat')),
    })
    if (!order) return c.json({ error: `RevenueCat order ${order_no} not found` }, 404)
    // Optionally: if (order.user_id !== user_id) return c.json({ error: 'User ID mismatch' }, 403);

    const confirmedOrder = await afterOrderConfirmation({
      order,
      amount_paid,
      payment_status: 'PAID',
      payment_reference_id,
      pg_name: 'RevenueCat',
      phone: phone ? parsePhoneNumber(phone) : order.phone,
      email: email || order.email,
    })
    return c.json({
      order_no: confirmedOrder.id,
      plan_id: confirmedOrder.plan_id,
      plan_price: confirmedOrder.total_amount,
      message: 'RevenueCat purchase confirmed.',
    })
  } catch (error: any) {
    console.error('RevenueCat capture error:', error)
    return c.json({ error: error.message || 'RevenueCat capture failed' }, error.status || 500)
  }
})

// Cash on Delivery checkout
checkoutRoutes.post('/cod', authenticate, async (c) => {
  try {
    const { items, deliveryAddress, totalAmount, paymentMethod, orderDate } = await c.req.json()

    if (!items || !Array.isArray(items) || items.length === 0) {
      return c.json({ error: 'Items are required' }, 400)
    }

    if (!deliveryAddress || !deliveryAddress.qrno) {
      return c.json({ error: 'Delivery address is required' }, 400)
    }

    if (!totalAmount || totalAmount <= 0) {
      return c.json({ error: 'Valid total amount is required' }, 400)
    }

    // Get user ID from context (assuming authentication middleware sets this)
    const user = c.get('user')
    const userId = user?.id

    // Extract foodIds from items
    const foodIds = items.map((item: any) => item.id || item.foodId)

    // Query foods to get hostId and price for each foodId
    const foods = await db.query.Product.findMany({
      where: inArray(Product.id, foodIds),
      columns: { id: true, hostId: true, price: true },
    })

    // Check if all foodIds exist
    if (foods.length !== foodIds.length) {
      return c.json({ error: 'One or more food items not found' }, 400)
    }

    // Create map of foodId to food details
    const foodMap = foods.reduce(
      (acc, food) => {
        acc[food.id] = { hostId: food.hostId, price: parseFloat(food.price) }
        return acc
      },
      {} as Record<string, { hostId: string; price: number }>
    )

    // Group items by hostId and calculate totals
    const hostGroups: Record<string, { items: any[]; totalAmount: number }> = {}
    for (const item of items) {
      const foodId = item.id || item.foodId
      const foodDetails = foodMap[foodId]
      if (!foodDetails) continue // Should not happen due to earlier check

      const hostId = foodDetails.hostId
      if (!hostGroups[hostId]) {
        hostGroups[hostId] = { items: [], totalAmount: 0 }
      }
      hostGroups[hostId].items.push(item)
      hostGroups[hostId].totalAmount += foodDetails.price * item.quantity
    }

    // Generate running serial number for order
    const orderCount = await db.$count(Order)
    const serialNumber = (orderCount + 1).toString().padStart(6, '0') // Pad with zeros to make it 6 digits
    const baseOrderNumber = `${serialNumber}`

    // Calculate total amount for all orders combined
    const totalOrderAmount = Object.values(hostGroups).reduce(
      (sum, group) => sum + group.totalAmount,
      0
    )

    // Create single payment record for the entire order
    const [paymentRecord] = await db
      .insert(Payment)
      .values({
        userId,
        orderNo: baseOrderNumber,
        totalAmount: totalOrderAmount.toString(),
        paymentStatus: 'pending',
        paymentMethod: paymentMethod || 'COD',
      })
      .returning()

    // Create orders for each host
    const createdOrders = []
    const hostCount = Object.keys(hostGroups).length
    let orderIndex = 1

    for (const [hostId, group] of Object.entries(hostGroups)) {
      // Generate internal order number - only add suffix if there are multiple vendors
      const internalOrderNumber =
        hostCount === 1 ? baseOrderNumber : `${baseOrderNumber}-${orderIndex}`

      // Calculate estimated delivery time
      const now = new Date()
      const estimatedDeliveryTime = new Date(now)
      estimatedDeliveryTime.setHours(18, 0, 0, 0) // 6:00 PM

      // Insert order into database with internal order number
      const [newOrder] = await db
        .insert(Order)
        .values({
          userId,
          hostId,
          orderNumber: internalOrderNumber,
          status: 'pending', // Orders start as pending, will be confirmed on payment success
          totalAmount: group.totalAmount.toString(),
          deliveryAddress,
          estimatedDeliveryTime,
          paymentStatus: 'pending', // COD payment is pending until delivery
          paymentMethod: paymentMethod || 'COD',
          paymentId: paymentRecord.id, // Link to payment record immediately
        })
        .returning()

      // Insert order items
      const orderItems = group.items.map((item: any) => ({
        orderId: newOrder.id,
        foodId: item.id || item.foodId,
        quantity: item.quantity,
        unitPrice: foodMap[item.id || item.foodId].price.toString(),
        totalPrice: (foodMap[item.id || item.foodId].price * item.quantity).toString(),
        specialRequests: item.specialRequests || null,
      }))

      await db.insert(OrderItem).values(orderItems)

      // Fetch host name for better user experience
      const host = await db.query.User.findFirst({
        where: eq(User.id, hostId),
        columns: { name: true },
      })

      createdOrders.push({
        orderId: newOrder.id,
        orderNo: baseOrderNumber, // Show customer the base order number
        parentOrderNo: internalOrderNumber, // Parent order number for internal reference
        paymentId: paymentRecord.id, // Use the same payment ID for all orders
        hostId,
        hostName: host?.name || 'Unknown Host', // Add host business name
        totalAmount: newOrder.totalAmount,
        status: 'pending', // Orders are created as pending
        estimatedDelivery: '6:00 PM - 9:30 PM',
        items: orderItems, // Display full item details instead of just count
      })

      orderIndex++
    }

    // Create order summary by host
    const orderSummary = []
    for (const [hostId, group] of Object.entries(hostGroups)) {
      const host = await db.query.User.findFirst({
        where: eq(User.id, hostId),
        columns: { name: true },
      })

      const hostItems = group.items.map((item: any) => ({
        name: item.name || 'Unknown Item',
        quantity: item.quantity,
        price: item.price || 0,
      }))

      orderSummary.push({
        hostName: host?.businessName || 'Unknown Host',
        items: hostItems,
        totalItems: hostItems.reduce((sum, item) => sum + item.quantity, 0),
        subtotal: group.totalAmount,
      })
    }

    return c.json({
      success: true,
      orderNo: baseOrderNumber, // Customer-facing order number
      paymentId: paymentRecord.id, // Shared payment ID for all orders
      orders: createdOrders,
      message: `${createdOrders.length} order(s) created and pending payment confirmation`,
      thankYouMessage: 'Thank you for ordering with HomeFood!',
      orderSummary: orderSummary, // Summary of all items grouped by host
    })
  } catch (error: any) {
    console.error('COD checkout error:', error)
    return c.json({ error: error.message || 'COD checkout failed' }, error.status || 500)
  }
})

// Payment success endpoint - updates all orders for a payment
checkoutRoutes.post('/payment-success', async (c) => {
  try {
    const { paymentId, paymentReferenceId, amountPaid } = await c.req.json()

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
