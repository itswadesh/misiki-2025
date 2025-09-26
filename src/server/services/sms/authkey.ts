import axios from 'axios'
import { env } from 'process'

const objToQueryString = (params: any) => {
  return Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
}

export const authKeyMessage = async ({ phone, otp }: { phone: string; otp: string }) => {
  try {
    // Template with placeholders that will be replaced
    const template = `<#> Hi, {#otp#} is your OTP to login to {#website#}`

    // Replace placeholders with actual values
    const msg = template.replace('{#otp#}', otp).replace('{#website#}', 'MISIKI')

    const voice = template.replace('{#otp#}', otp).replace('{#website#}', 'MISIKI')

    phone = phone.replace('+91', '')

    const params = {
      authkey: env.SMS_AUTHKEY_API_KEY,
      sms: msg,
      fb1voice: voice,
      mobile: phone,
      country_code: '91',
      sender: env.SMS_AUTHKEY_SENDER_ID,
      pe_id: env.SMS_ENTITY_ID,
      template_id: env.SMS_OTP_TEMPLATE_ID,
    }

    const url = `https://api.authkey.io/request?${objToQueryString(params)}`
    console.log('URL.............', url)
    const res = await axios.get(url, {})
    return res?.data?.Message
  } catch (error) {
    console.error('smsAuthKey err...', error?.toString())
    return error?.toString()
  }
}
