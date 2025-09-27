<script lang="ts">
import { onMount, tick } from 'svelte'
import { goto } from '$app/navigation'
import { loadStripe } from '@stripe/stripe-js'
import { PUBLIC_STRIPE_PUBLISHABLE_KEY } from '$env/static/public'

let planId = $state('')
let totalAmount = $state(0)
let couponCode = $state('')
let paymentMethod = $state('billie') // 'card' or 'billie'

const paymentElementClass = $derived(
  paymentMethod === 'card' ? '' : 'opacity-0 pointer-events-none absolute'
)
const addressElementClass = $derived(
  paymentMethod === 'billie' ? '' : 'opacity-0 pointer-events-none absolute'
)

let stripe: any = null
let elements: any = null
let paymentElement: any = null
let addressElement: any = null

let isLoading = $state(false)
let error = $state('')
let clientSecret = $state('')
let orderId = $state('')

async function initializePayment() {
  if (!stripe) {
    stripe = await loadStripe(PUBLIC_STRIPE_PUBLISHABLE_KEY)
  }

  // Create PaymentIntent
  try {
    const response = await fetch('/api/checkout/stripe-checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: planId,
        total_amount: totalAmount,
        couponCode: couponCode || undefined,
        payment_method_type: paymentMethod,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to create payment intent')
    }

    const result = await response.json()
    clientSecret = result.client_secret
    orderId = result.order_id

    if (!clientSecret) {
      throw new Error('No client secret received')
    }

    // Create Elements
    elements = stripe.elements({
      clientSecret,
      appearance: {
        theme: 'stripe',
      },
    })

    // Clear previous elements
    if (paymentElement) {
      paymentElement.unmount()
      paymentElement = null
    }
    if (addressElement) {
      addressElement.unmount()
      addressElement = null
    }

    // Create appropriate element based on payment method
    if (paymentMethod === 'card') {
      paymentElement = elements.create('payment')
      await tick()
      paymentElement.mount('#payment-element')
    } else if (paymentMethod === 'billie') {
      addressElement = elements.create('address', {
        mode: 'billing',
        allowedCountries: ['DE', 'AT', 'CH'],
        defaultValues: {
          address: {
            country: 'DE',
          },
        },
      })
      await tick()
      addressElement.mount('#address-element')
    }
  } catch (err) {
    error = 'Failed to initialize payment'
    console.error(err)
  }
}

onMount(async () => {
  const urlParams = new URLSearchParams(window.location.search)
  planId = urlParams.get('plan_id') || ''
  totalAmount = parseFloat(urlParams.get('total_amount') || '0')
  couponCode = urlParams.get('coupon') || ''

  await initializePayment()
})

function handlePaymentMethodChange() {
  initializePayment()
}

async function handleSubmit() {
  if (!stripe || !elements) {
    error = 'Payment system not initialized'
    return
  }

  isLoading = true
  error = ''

  try {
    const { error: submitError } = await elements.submit()

    if (submitError) {
      error = submitError.message || 'Form submission failed'
      return
    }

    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/orders`,
      },
    })

    if (confirmError) {
      error = confirmError.message || 'Payment confirmation failed'
    } else {
      // Payment succeeded, confirm on server
      await fetch('/api/checkout/stripe-confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payment_intent_id: clientSecret.split('_secret_')[0],
          order_id: orderId,
        }),
      })

      goto('/orders')
    }
  } catch (err) {
    error = 'An error occurred during payment'
    console.error(err)
  } finally {
    isLoading = false
  }
}
</script>

<div class="max-w-md mx-auto p-6 bg-white rounded-lg shadow-md">
  <h1 class="text-2xl font-bold mb-6">Pay with Stripe</h1>

  {#if error}
    <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
      {error}
    </div>
  {/if}

  <form on:submit|preventDefault={handleSubmit} class="space-y-4">
    <!-- Payment Method Selector -->
    <div>
      <label for="payment-method" class="block text-sm font-medium text-gray-700 mb-2">Payment Method</label>
      <select
        id="payment-method"
        bind:value={paymentMethod}
        on:change={handlePaymentMethodChange}
        class="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
      >
        <option value="card">Credit/Debit Card</option>
        <option value="billie">Billie (Buy Now, Pay Later)</option>
      </select>
    </div>

    <!-- Stripe Elements -->
    <div id="payment-element" class={paymentElementClass}></div>
    <div id="address-element" class={addressElementClass}></div>

    <div class="bg-gray-50 p-4 rounded-md">
      <p class="text-sm text-gray-600">
        Plan: {planId}<br>
        Amount: {paymentMethod === 'billie' ? '€' : '$'}{totalAmount.toFixed(2)}
        {#if couponCode}
          <br>Coupon: {couponCode}
        {/if}
      </p>
    </div>

    <button
      type="submit"
      disabled={isLoading}
      class="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
    >
      {#if isLoading}
        Processing...
      {:else}
        Pay {paymentMethod === 'card' ? 'with Card' : 'with Billie'}
      {/if}
    </button>
  </form>
</div>