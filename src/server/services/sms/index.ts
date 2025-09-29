import { authKeyMessage } from './authkey'
// import { msg91Message } from './msg91'

export const sendOtpSms = async ({ phone, otp }: { phone: string; otp: string }) => {
  await authKeyMessage({ phone, otp })
  // await msg91Message({
  //   usedFor: 'otp',
  //   phone,
  //   otp,
  //   dlt_template_id: '66038591d6fc056ec43f2593',
  //   variables: {
  //     otp,
  //     website: 'LRNR'
  //   }
  // })
}

export const sendOrderConfirmationSms = async ({
  phone,
  orderNo,
  totalAmount,
}: {
  phone: string
  orderNo: string
  totalAmount: string
}) => {
  try {
    const template = `Hi, your order {#orderNo#} for Rs.{#amount#} has been confirmed. Thank you for ordering with Misiki!`

    const msg = template.replace('{#orderNo#}', orderNo).replace('{#amount#}', totalAmount)

    phone = phone.replace('+91', '')

    const params = {
      authkey: process.env.SMS_AUTHKEY_API_KEY || '',
      sms: msg,
      mobile: phone,
      country_code: '91',
      sender: process.env.SMS_AUTHKEY_SENDER_ID || '',
      pe_id: process.env.SMS_ENTITY_ID || '',
      template_id: process.env.SMS_ORDER_TEMPLATE_ID || process.env.SMS_OTP_TEMPLATE_ID || '', // Use order template or fallback to OTP
    }

    const queryString = Object.keys(params)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent((params as any)[k])}`)
      .join('&')
    const url = `https://api.authkey.io/request?${queryString}`
    console.log('Order confirmation SMS URL.............', url)

    const axios = (await import('axios')).default
    const res = await axios.get(url)
    return res?.data?.Message
  } catch (error) {
    console.error('Order confirmation SMS error...', error?.toString())
    return error?.toString()
  }
}

export const sendNewOrderNotificationSms = async ({
  phone,
  orderNo,
  customerName,
  totalAmount,
}: {
  phone: string
  orderNo: string
  customerName: string
  totalAmount: string
}) => {
  try {
    const template = `New order received! Order {#orderNo#} from {#customer#} for Rs.{#amount#}. Please prepare the order.`

    const msg = template
      .replace('{#orderNo#}', orderNo)
      .replace('{#customer#}', customerName || 'Customer')
      .replace('{#amount#}', totalAmount)

    phone = phone.replace('+91', '')

    const params = {
      authkey: process.env.SMS_AUTHKEY_API_KEY || '',
      sms: msg,
      mobile: phone,
      country_code: '91',
      sender: process.env.SMS_AUTHKEY_SENDER_ID || '',
      pe_id: process.env.SMS_ENTITY_ID || '',
      template_id: process.env.SMS_ORDER_TEMPLATE_ID || process.env.SMS_OTP_TEMPLATE_ID || '', // Use order template or fallback to OTP
    }

    const queryString = Object.keys(params)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent((params as any)[k])}`)
      .join('&')
    const url = `https://api.authkey.io/request?${queryString}`
    console.log('New order notification SMS URL.............', url)

    const axios = (await import('axios')).default
    const res = await axios.get(url)
    return res?.data?.Message
  } catch (error) {
    console.error('New order notification SMS error...', error?.toString())
    return error?.toString()
  }
}
