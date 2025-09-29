import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { capturePhonepe } from './phonepe/capture'
import { phonepeCheckout } from './phonepe/checkout'

// Create a PhonePe router
export const phonepeRoutes = new Hono()

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
phonepeRoutes
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
      const { order_no, origin } = c.req.query()
      if (!order_no) {
        return c.json({ error: 'order_no is required' }, 400)
      }
      // capturePhonepe is expected to handle the response (e.g., redirect or JSON)
      await capturePhonepe({ c, orderNo: order_no, origin })
    } catch (e: any) {
      console.error('PhonePe capture error:', e)
      return c.json({ error: e.message || 'PhonePe capture failed' }, e.status || 500)
    }
  })

// PhonePe webhook
phonepeRoutes.post('/webhook/phonepe', async (c) => {
  try {
    const data = await c.req.json()
    // TODO: Add actual PhonePe signature verification logic here
    const { merchantTransactionId, status, amount, providerReferenceId } = data.data // Adjust path based on actual payload
    const orderId = merchantTransactionId

    if (!orderId) return c.json({ error: 'Order ID (merchantTransactionId) missing' }, 400)

    const { db } = await import('../../db')
    const { Order } = await import('../../db/schema')
    const { afterOrderConfirmation } = await import('./utils')

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
