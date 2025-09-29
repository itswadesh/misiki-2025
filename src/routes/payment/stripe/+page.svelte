<script lang="ts">
import { onMount, tick } from 'svelte'
import { goto } from '$app/navigation'
import { loadStripe } from '@stripe/stripe-js'
import { PUBLIC_STRIPE_PUBLISHABLE_KEY } from '$env/static/public'
import { createEventDispatcher } from 'svelte'

const dispatch = createEventDispatcher()

let planId = $state('')
let totalAmount = $state(0)
let couponCode = $state('')
let selectedPaymentMethod = $state('card')

const paymentElementClass = $derived(
  selectedPaymentMethod === 'card' ? '' : 'opacity-0 pointer-events-none absolute'
)
const addressElementClass = $derived(
  selectedPaymentMethod === 'billie' ? '' : 'opacity-0 pointer-events-none absolute'
)

let stripe: any = null
let elements: any = null
let paymentElement: any = null
let addressElement: any = null

let isLoading = $state(false)
let error = $state('')
let clientSecret = $state('')
let orderId = $state('')

// Form configuration props
let {
  title = 'Secure Payment',
  showTabs = true,
  paymentMethods = [
    { id: 'card', label: 'Credit/Debit Card' },
    { id: 'billie', label: 'Billie (Buy Now, Pay Later)' },
  ],
  showSummary = true,
  submitButtonText = 'Complete Payment',
} = $props()

// Event handlers for customization
export function handleFormSubmit() {
  dispatch('submit', { planId, totalAmount, couponCode, selectedPaymentMethod })
}

export function handleTabChange(paymentMethod: string) {
  selectedPaymentMethod = paymentMethod
  dispatch('tabChange', { paymentMethod })
}

async function initializePayment(paymentMethod: string) {
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

  await initializePayment(selectedPaymentMethod)
})

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

    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/orders`,
      },
    })

    if (confirmError) {
      // Handle different types of errors
      if (confirmError.type === 'card_error') {
        error = confirmError.message || 'Your card was declined. Please try a different payment method.'
      } else if (confirmError.type === 'validation_error') {
        error = confirmError.message || 'Please check your payment information and try again.'
      } else if (confirmError.type === 'api_connection_error') {
        error = 'Network error. Please check your connection and try again.'
      } else if (confirmError.type === 'api_error') {
        error = 'Payment service temporarily unavailable. Please try again later.'
      } else if (confirmError.type === 'authentication_error') {
        error = 'Authentication failed. Please try again.'
      } else if (confirmError.type === 'rate_limit_error') {
        error = 'Too many attempts. Please wait a moment and try again.'
      } else {
        error = confirmError.message || 'An unexpected error occurred during payment.'
      }
    } else if (paymentIntent && paymentIntent.status === 'requires_action') {
      // Handle 3D Secure authentication
      const { error: authError } = await stripe.confirmCardPayment(paymentIntent.client_secret)

      if (authError) {
        error = authError.message || 'Authentication failed'
      } else {
        // Authentication succeeded, confirm on server
        await confirmPaymentOnServer(paymentIntent.id)
      }
    } else if (paymentIntent && paymentIntent.status === 'succeeded') {
      // Payment succeeded immediately
      await confirmPaymentOnServer(paymentIntent.id)
    } else {
      error = 'Payment processing failed'
    }
  } catch (err) {
    error = 'An error occurred during payment'
    console.error(err)
  } finally {
    isLoading = false
  }
}

async function confirmPaymentOnServer(paymentIntentId: string) {
  try {
    const response = await fetch('/api/checkout/stripe-confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payment_intent_id: paymentIntentId,
        order_id: orderId,
      }),
    })

    const result = await response.json()

    if (response.ok && result.success) {
      goto('/orders')
    } else if (result.requires_action) {
      // Handle additional authentication required
      const { error: authError } = await stripe.confirmCardPayment(result.payment_intent_client_secret)

      if (authError) {
        error = authError.message || 'Authentication failed'
      } else {
        // Retry confirmation after authentication
        await confirmPaymentOnServer(paymentIntentId)
      }
    } else if (result.status === 'requires_payment_method') {
      error = 'Payment failed. Please try a different payment method.'
    } else if (result.status === 'requires_action') {
      error = 'Additional authentication required. Please complete the verification process.'
    } else {
      error = result.error || 'Payment confirmation failed'
    }
  } catch (err) {
    error = 'Failed to confirm payment on server'
    console.error(err)
  }
}
</script>

<div class="max-w-md mx-auto p-6 bg-white rounded-lg shadow-md">
  <h1 class="text-2xl font-bold mb-6">{title}</h1>

  {#if error}
    <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
      {error}
    </div>
  {/if}

  {#if showTabs && paymentMethods.length > 1}
    <div class="flex border-b mb-4">
      {#each paymentMethods as method}
        <button
          class="px-4 py-2 text-sm font-medium {selectedPaymentMethod === method.id ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500'}"
          onclick={() => { selectedPaymentMethod = method.id; initializePayment(method.id); handleTabChange(method.id); }}
        >
          {method.label}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Stripe Elements -->
  <div id="payment-element" class={paymentElementClass}></div>
  <div id="address-element" class={addressElementClass}></div>

  {#if showSummary}
    <div class="bg-gray-50 p-4 rounded-md">
      <p class="text-sm text-gray-600">
        Plan: {planId}<br>
        Amount: ${totalAmount.toFixed(2)}
        {#if couponCode}
          <br>Coupon: {couponCode}
        {/if}
      </p>
    </div>
  {/if}

  <button
    onclick={async () => await handleSubmit()}
    disabled={isLoading}
    class="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
  >
    {#if isLoading}
      Processing...
    {:else}
      {submitButtonText}
    {/if}
  </button>
</div>