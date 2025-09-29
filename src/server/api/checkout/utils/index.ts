import { and, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { Coupon, Order, Plan } from '../../../db/schema'
import 'dotenv/config'

export const confirmOrder = async (order_no: string, isConfirmOrder = true) => {
  const orders = await db.select().from(Order).where(eq(Order.id, order_no))
  const order = orders[0]
  if (!order) throw { status: 404, message: 'Order not found' }
  let paid = false
  let status = 'created'
  let comment = 'Order placed successfully'

  if (order.pgName?.toUpperCase() === 'COD') {
    paid = false
  } else {
    paid = true
    if (isConfirmOrder) {
      const planDetails = await db.select().from(Plan).where(eq(Plan.id, order.planId))
      status = 'confirmed'
      comment = 'Order confirmed'
      const validFrom = new Date()
      const today = new Date()
      const daysToAdd = +(planDetails[0]?.validity || '0')
      const millisecondsPerDay = 1000 * 60 * 60 * 24
      const validTo = new Date(today.getTime() + daysToAdd * millisecondsPerDay)
      await db
        .update(Order)
        .set({ status, comment, isPaid: paid, validFrom, validTo, paymentStatus: 'PAID' })
        .where(and(eq(Order.id, order_no)))
    } else {
      await db
        .update(Order)
        .set({ status, comment, isPaid: paid, paymentStatus: 'PAID' })
        .where(and(eq(Order.id, order_no)))
    }
  }
}

export const afterOrderConfirmation = async ({
  order,
  amount_paid,
  payment_status,
  payment_reference_id,
  phone,
  email,
}: any) => {
  if (!order) throw { status: 404, message: 'Order not found' }
  let amountPaid = 0
  let amountDue = order.amount_due
  // let payment_status = 'PENDING'
  let paid = false
  let order_status = 'created'
  let paySuccess = order.paySuccess
  let txMsg = ''
  if (
    payment_status === 'paid' ||
    payment_status === 'captured' ||
    payment_status === 'approved' ||
    payment_status === 'authorized' // TODO:: THIS IS UNDER DOUBT. Need to research Razorpay docs
  ) {
    amountPaid = amount_paid / 100
    amountDue = order.amountDue - amountPaid
    if (amountDue < 0) amountDue = 0
    txMsg = `Payment done for Misiki of amount ${amountPaid}`
    payment_status = 'PAID'
    order_status = 'confirmed'
    paid = true
    if (paySuccess < 1) paySuccess = 1
    await confirmOrder(order.id)
  } else {
    payment_status = 'FAILED'
  }

  const updatedOrder = await db
    .update(Order)
    .set({
      paymentStatus: payment_status, // This is required, because order status will change later
      paymentReferenceId: payment_reference_id,
      amountPaid,
      isPaid: paid,
      status: order_status,
      paymentRemark: txMsg,
      phone,
      email,
    })
    .where(eq(Order.id, order.id))
    .returning({ id: Order.id, planId: Order.planId })
  return updatedOrder[0]
}

export const razorpayGetOrderInfo = async ({ pg, paymentReferenceId }: any) => {
  const razorpayInstance = new Razorpay({
    key_id: pg?.app_id,
    key_secret: pg?.app_secret,
  })
  const rzOrder = await razorpayInstance.orders.fetch(paymentReferenceId)
  // if (!rzOrder) throw { status: 400, message: 'Payment failed' }
  return c.json(rzOrder)
}

export const placeOrder = async ({
  pgName,
  totalAmount,
  planId,
  couponCode,
  phone,
  userId,
  paymentId,
}: any) => {
  let discountedAmount = totalAmount
  if (couponCode) {
    const coupon = await db
      .select()
      .from(Coupon)
      .where(and(eq(Coupon.couponCode, couponCode), eq(Coupon.isActive, true)))
    if (coupon.length > 0) {
      const discount = parseFloat(coupon[0].discount) || 0
      if (coupon[0].discountType === 'percentage') {
        discountedAmount = Math.round((totalAmount - (totalAmount * discount) / 100) * 100) / 100
      } else {
        discountedAmount = totalAmount - discount
      }
    }
  }

  // Get current timestamp in milliseconds since epoch
  const now = new Date()
  const orderId = `ord_${now.getTime()}_${Math.random().toString(36).substring(2, 10)}`
  const orderNo = `ORD-${now.getTime().toString().slice(-6)}`

  const OrderValues = {
    id: orderId,
    userId: userId,
    hostId: userId, // For subscriptions, host is the user
    orderNumber: orderNo,
    status: 'created',
    totalAmount: discountedAmount.toFixed(2), // In dollars
    paymentStatus: 'pending',
    paymentMethod: pgName,
    comment: null,
    paymentId: paymentId,
  }
  const plan = await db.query.Plan.findFirst({ where: eq(Plan.id, planId) })
  if (plan) OrderValues.validTo = new Date(now.getTime() + plan.validity * 24 * 60 * 60 * 1000)

  let order: any = {}
  const orderRes = await db.insert(Order).values(OrderValues).returning()
  if (orderRes) {
    order = orderRes[0]
  }
  if (!order) throw { status: 400, message: 'Payment failed' }

  return order
}
