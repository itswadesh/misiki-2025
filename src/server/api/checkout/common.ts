import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { Order, OrderItem, Product, Payment, User } from '../../db/schema'

// Common function to process food orders
export async function processFoodOrder(
  items: any[],
  deliveryAddress: any,
  totalAmount: number,
  paymentMethod: string,
  userId: string
) {
  // Extract foodIds from items
  const foodIds = items.map((item: any) => item.id || item.foodId)

  // Query foods to get hostId and price
  const foods = await db.query.Product.findMany({
    where: inArray(Product.id, foodIds),
    columns: { id: true, hostId: true, price: true },
  })

  // Check if all foodIds exist
  if (foods.length !== foodIds.length) {
    throw new Error('One or more food items not found')
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
    if (!foodDetails) continue

    const hostId = foodDetails.hostId
    if (!hostGroups[hostId]) {
      hostGroups[hostId] = { items: [], totalAmount: 0 }
    }
    hostGroups[hostId].items.push(item)
    hostGroups[hostId].totalAmount += foodDetails.price * item.quantity
  }

  // Generate running serial number for order
  const orderCount = await db.$count(Order)
  const serialNumber = (orderCount + 1).toString().padStart(6, '0')
  const baseOrderNumber = `${serialNumber}`

  // Calculate total amount for all orders combined
  const totalOrderAmount = Object.values(hostGroups).reduce(
    (sum, group) => sum + group.totalAmount,
    0
  )

  // Create single payment record
  const [paymentRecord] = await db
    .insert(Payment)
    .values({
      userId,
      orderNo: baseOrderNumber,
      totalAmount: totalOrderAmount.toString(),
      paymentStatus: 'pending',
      paymentMethod: paymentMethod,
    })
    .returning()

  // Create orders for each host
  const createdOrders = []
  const hostCount = Object.keys(hostGroups).length
  let orderIndex = 1

  for (const [hostId, group] of Object.entries(hostGroups)) {
    // Generate internal order number
    const internalOrderNumber =
      hostCount === 1 ? baseOrderNumber : `${baseOrderNumber}-${orderIndex}`

    // Calculate estimated delivery time
    const now = new Date()
    const estimatedDeliveryTime = new Date(now)
    estimatedDeliveryTime.setHours(18, 0, 0, 0) // 6:00 PM

    // Insert order
    const [newOrder] = await db
      .insert(Order)
      .values({
        userId,
        hostId,
        orderNumber: internalOrderNumber,
        status: 'pending',
        totalAmount: group.totalAmount.toString(),
        deliveryAddress,
        estimatedDeliveryTime,
        paymentStatus: 'pending',
        paymentMethod: paymentMethod,
        paymentId: paymentRecord.id,
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

    // Fetch host name
    const host = await db.query.User.findFirst({
      where: eq(User.id, hostId),
      columns: { name: true },
    })

    createdOrders.push({
      orderId: newOrder.id,
      orderNo: baseOrderNumber,
      parentOrderNo: internalOrderNumber,
      paymentId: paymentRecord.id,
      hostId,
      hostName: host?.name || 'Unknown Host',
      totalAmount: newOrder.totalAmount,
      status: 'pending',
      estimatedDelivery: '6:00 PM - 9:30 PM',
      items: orderItems,
    })

    orderIndex++
  }

  // Create order summary
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
      hostName: host?.name || 'Unknown Host',
      items: hostItems,
      totalItems: hostItems.reduce((sum, item) => sum + item.quantity, 0),
      subtotal: group.totalAmount,
    })
  }

  return {
    orderNo: baseOrderNumber,
    paymentId: paymentRecord.id,
    orders: createdOrders,
    orderSummary,
    totalOrderAmount,
  }
}
