import { Hono } from 'hono'
import { phonepeRoutes } from './phonepe'
import { razorpayRoutes } from './razorpay'
import { stripeRoutes } from './stripe'
import { revenuecatRoutes } from './revenuecat'
import { codRoutes } from './cod'

const checkoutRoutes = new Hono()

// Add all route groups
checkoutRoutes.route('/', phonepeRoutes)
checkoutRoutes.route('/', razorpayRoutes)
checkoutRoutes.route('/', stripeRoutes)
checkoutRoutes.route('/', revenuecatRoutes)
checkoutRoutes.route('/', codRoutes)

export { checkoutRoutes }
