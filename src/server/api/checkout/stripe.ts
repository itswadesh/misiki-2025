import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import Stripe from 'stripe'
import { db } from '../../db'
import { Order, Payment } from '../../db/schema'
import { afterOrderConfirmation, placeOrder } from './utils'
import { validateCoupon as validateCouponUtil } from './validate-coupon'
import { authenticate } from '@/server/middlewares'
import { processFoodOrder } from './common'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

// Create a Stripe router
export const stripeRoutes = new Hono()

// Stripe checkout - create PaymentIntent for food orders or subscriptions
stripeRoutes.post('/stripe-checkout', authenticate, async (c) => {
  try {
    const body = await c.req.json()
    const {
      items,
      deliveryAddress,
      totalAmount: providedTotalAmount,
      paymentMethod,
      plan_id,
      couponCode,
      payment_method_type,
    } = body

    // Calculate total amount from items if not provided
    let totalAmount = providedTotalAmount
    if (!totalAmount && items && Array.isArray(items)) {
      totalAmount = items.reduce((sum, item) => sum + (item.price || 0) * (item.quantity || 1), 0)
    }

    // Check if it's a subscription or food order
    const isSubscription = plan_id !== undefined
    const isFoodOrder = !isSubscription && items && Array.isArray(items) && items.length > 0

    if (isSubscription) {
      // Subscription logic
      const user = c.get('user') as any
      const userId = user?.id

      if (!userId) {
        return c.json({ error: 'User not authenticated' }, 401)
      }

      if (!totalAmount || totalAmount <= 0) {
        return c.json({ error: 'Valid total amount is required' }, 400)
      }

      // Create order using placeOrder
      const order = await placeOrder({
        pgName: 'Stripe',
        totalAmount,
        planId: plan_id,
        couponCode,
        userId,
      })

      // Create Payment record
      const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
      await db.insert(Payment).values({
        id: paymentId,
        userId,
        orderNo: order.orderNumber,
        totalAmount: (totalAmount * 100).toString(), // in cents
        paymentStatus: 'pending',
        paymentMethod: 'Stripe',
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      // Update order with paymentId
      await db
        .update(Order)
        .set({
          paymentId,
        })
        .where(eq(Order.id, order.id))

      // Create PaymentIntent for subscription
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totalAmount * 100),
        currency: 'gbp',
        payment_method_types: payment_method_type === 'billie' ? ['card', 'billie'] : ['card'],
        metadata: {
          order_id: order.id,
          payment_id: paymentId,
        },
      })

      // Update payment with payment reference
      await db
        .update(Payment)
        .set({
          paymentReferenceId: paymentIntent.id,
        })
        .where(eq(Payment.id, paymentId))

      return c.json({
        success: true,
        order_id: order.id,
        client_secret: paymentIntent.client_secret,
        message: 'Subscription payment intent created',
      })
    } else if (isFoodOrder) {
      // Food order validation
      if (!deliveryAddress || !deliveryAddress.qrno) {
        return c.json({ error: 'Delivery address is required' }, 400)
      }

      if (!totalAmount || totalAmount <= 0) {
        return c.json({ error: 'Valid total amount is required' }, 400)
      }
    }

    // Get user ID from context
    const user = c.get('user') as any
    const userId = user?.id

    if (isFoodOrder) {
      // Food order logic
      const result = await processFoodOrder(
        items,
        deliveryAddress,
        totalAmount,
        paymentMethod || 'Stripe',
        userId
      )

      // Create PaymentIntent with Stripe
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(result.totalOrderAmount * 100), // Amount in cents
        currency: 'usd', // Assuming USD
        payment_method_types: ['card'], // Can be expanded
        metadata: {
          payment_id: result.paymentId,
          order_no: result.orderNo,
        },
      })

      // Update payment record with payment intent id
      await db
        .update(Payment)
        .set({
          paymentReferenceId: paymentIntent.id,
        })
        .where(eq(Payment.id, result.paymentId))

      return c.json({
        success: true,
        orderNo: result.orderNo,
        paymentId: result.paymentId,
        orders: result.orders,
        client_secret: paymentIntent.client_secret,
        message: `${result.orders.length} order(s) created and pending payment`,
        thankYouMessage: 'Thank you for ordering with HomeFood!',
        orderSummary: result.orderSummary,
      })
    } else {
      return c.json({ error: 'Invalid request: subscription payments not supported' }, 400)
    }
  } catch (error: any) {
    console.error(error.message || error)
    return c.json({ error: error.message || 'Stripe checkout failed' }, error.status || 500)
  }
})

// Stripe confirm payment
stripeRoutes.post('/stripe-confirm', async (c) => {
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
      return c.json(
        {
          error: 'Payment failed - please try a different payment method',
          status: paymentIntent.status,
        },
        400
      )
    } else if (paymentIntent.status === 'requires_action') {
      // Authentication required
      return c.json({
        requires_action: true,
        payment_intent_client_secret: paymentIntent.client_secret,
        status: paymentIntent.status,
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
    console.error(error.message || error)
    return c.json({ error: error.message || 'Stripe confirm failed' }, error.status || 500)
  }
})

// Stripe webhook
stripeRoutes.post('/webhook/stripe', async (c) => {
  const sig = c.req.header('stripe-signature')
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET

  let event: Stripe.Event

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
      const paymentId = paymentIntent.metadata.payment_id

      if (orderId) {
        // Subscription order
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
      } else if (paymentId) {
        // Food orders
        // Update payment status to paid
        await db
          .update(Payment)
          .set({
            paymentStatus: 'paid',
            paymentReferenceId: paymentIntent.id,
            updatedAt: new Date(),
          })
          .where(eq(Payment.id, paymentId))

        // Find all orders with this paymentId
        const ordersToUpdate = await db.query.Order.findMany({
          where: eq(Order.paymentId, paymentId),
        })

        // Update all orders to confirmed and paid status
        for (const order of ordersToUpdate) {
          await db
            .update(Order)
            .set({
              status: 'confirmed',
              paymentStatus: 'paid',
              updatedAt: new Date(),
            })
            .where(eq(Order.id, order.id))
        }

        console.log(`Food orders for payment ${paymentId} fulfilled via webhook`)
      } else {
        console.error('No order_id or payment_id in payment_intent metadata')
        return c.json({ error: 'No order_id or payment_id in metadata' }, 400)
      }
    } else if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object
      const orderId = paymentIntent.metadata.order_id
      const paymentId = paymentIntent.metadata.payment_id

      if (orderId) {
        // Subscription order
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
      } else if (paymentId) {
        // Food orders
        await db
          .update(Payment)
          .set({
            paymentStatus: 'failed',
            paymentReferenceId: paymentIntent.id,
            updatedAt: new Date(),
          })
          .where(eq(Payment.id, paymentId))

        // Update orders to failed
        const ordersToUpdate = await db.query.Order.findMany({
          where: eq(Order.paymentId, paymentId),
        })

        for (const order of ordersToUpdate) {
          await db
            .update(Order)
            .set({
              status: 'cancelled',
              paymentStatus: 'failed',
              updatedAt: new Date(),
            })
            .where(eq(Order.id, order.id))
        }
      }
    }

    return c.json({ received: true })
  } catch (error: any) {
    console.error(error.message || error)
    return c.json({ error: error.message || 'Webhook processing failed' }, 500)
  }
})
