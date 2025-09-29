import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import Razorpay from 'razorpay'
import { db } from '../../db'
import { Order, Plan, User, OrderItem } from '../../db/schema'
import { afterOrderConfirmation, placeOrder } from './utils'
import { validateCoupon as validateCouponUtil } from './validate-coupon'

// Create a Razorpay router
export const razorpayRoutes = new Hono()

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

// Razorpay checkout
razorpayRoutes.post('/checkout/razorpay', async (c) => {
  try {
    const { total_amount, plan_id, phone, couponCode } = await c.req.json()
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

    await db
      .update(Order)
      .set({ paymentOrderId: rzOrder.id } as any)
      .where(eq(Order.id, newOrder.id))

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
razorpayRoutes.post('/checkout/razorpay-capture', async (c) => {
  let db_order_id_for_error_handling: string | undefined
  try {
    const args = await c.req.json()
    const { razorpay_order_id, razorpay_payment_id, receipt_db_order_id } = args
    db_order_id_for_error_handling = receipt_db_order_id

    // TODO: Verify Razorpay signature
    // import crypto from 'crypto';
    // const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!];
    // shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    // if (shasum.digest('hex') !== razorpay_signature) return c.json({ error: 'Invalid signature' }, 400);

    const order = await db.query.Order.findFirst({
      where: and(
        eq(Order.id, receipt_db_order_id),
        eq((Order as any).paymentOrderId, razorpay_order_id)
      ),
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
      amount_paid: (paymentDetails.amount as number) / 100,
      payment_status: 'PAID',
      payment_reference_id: razorpay_payment_id,
      pg_name: 'Razorpay',
      phone: paymentDetails.contact
        ? parsePhoneNumber(paymentDetails.contact as string)
        : (order as any).phone,
      email: paymentDetails.email || (order as any).email,
    })

    const planDetails = await db.query.Plan.findFirst({
      where: eq(Plan.id, confirmedOrder.planId),
    })
    return c.json({
      order_no: confirmedOrder.id,
      plan_id: confirmedOrder.planId,
      plan_price: planDetails?.price,
      message: 'Payment successful',
    })
  } catch (error: any) {
    console.error('Razorpay capture error:', error)
    if (db_order_id_for_error_handling) {
      const order = await db.query.Order.findFirst({
        where: eq(Order.id, db_order_id_for_error_handling),
      })
      if (order && order.paymentStatus !== 'PAID') {
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
