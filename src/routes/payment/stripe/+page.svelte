<script lang="ts">
import { onMount, tick } from 'svelte'
import { goto } from '$app/navigation'
import { loadStripe } from '@stripe/stripe-js'
import { PUBLIC_STRIPE_PUBLISHABLE_KEY } from '$env/static/public'
import { createEventDispatcher } from 'svelte'
import { CreditCard, MoreHorizontal } from '@lucide/svelte'

const dispatch = createEventDispatcher()

let planId = $state('')
let totalAmount = $state(0)
let couponCode = $state('')
let selectedMethod = $state('card')

const paymentElementClass = $derived(
  selectedMethod === 'card' ? '' : 'opacity-0 pointer-events-none absolute'
)
const addressElementClass = $derived(
  selectedMethod === 'billie' ? '' : 'opacity-0 pointer-events-none absolute'
)

let stripe: any = null
let elements: any = null
let paymentElement: any = null
let addressElement: any = null

let isLoading = $state(false)
let isInitializing = $state(false)
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
  dispatch('submit', { planId, totalAmount, couponCode, selectedMethod })
}

export function handleSelectionChange(method: string) {
  selectedMethod = method
  error = ''
  initializePayment(method)
  dispatch('selectionChange', { method })
}

async function initializePayment(paymentMethod: string) {
  isInitializing = true
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
        couponCode: couponCode || undefined,
        payment_method_type: paymentMethod,
        items: [
          { name: 'Premium Subscription', quantity: 1, price: 9.99 },
          { name: 'Setup Fee', quantity: 1, price: 0.01 },
        ],
        deliveryAddress: {
          qrno: 'DUMMY_QR_123',
          address: '123 Dummy Street',
          city: 'Dummy City',
          state: 'Dummy State',
          zip: '12345',
        },
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
        layout: {
          type: 'accordion',
          defaultCollapsed: false,
        },
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
    error = err.message || 'Failed to initialize payment'
    console.error(err)
  } finally {
    isInitializing = false
  }
}

let initialized = false

onMount(async () => {
  const urlParams = new URLSearchParams(window.location.search)
  planId = urlParams.get('plan_id') || ''
  totalAmount = parseFloat(urlParams.get('total_amount') || '0')
  couponCode = urlParams.get('coupon') || ''

  await initializePayment(selectedMethod || 'card')
  initialized = true
})

$effect(() => {
  if (initialized) {
    initializePayment(selectedMethod)
    dispatch('selectionChange', { method: selectedMethod })
  }
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
        error =
          confirmError.message || 'Your card was declined. Please try a different payment method.'
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
      const { error: authError } = await stripe.confirmCardPayment(
        result.payment_intent_client_secret
      )

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

<div class="w-full max-w-md mx-auto p-8 bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
  <div class="flex gap-3 mb-6">
    <!-- Card Button -->
    <button
      onclick={() => handleSelectionChange('card')}
      class={`flex items-center gap-3 px-6 py-4 rounded-xl border-2 transition-all ${
        selectedMethod === 'card'
          ? 'border-blue-600 bg-white dark:bg-gray-800'
          : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-500'
      }`}
    >
      <div class="w-10 h-10 bg-slate-800 dark:bg-slate-700 rounded-lg flex items-center justify-center">
        <CreditCard class="w-5 h-5 text-white" />
      </div>
      <span class="text-lg font-semibold text-slate-800 dark:text-slate-200">Card</span>
    </button>

    <!-- Billie Button -->
    <button
      onclick={() => handleSelectionChange('billie')}
      class={`flex items-center gap-3 px-6 py-4 rounded-xl border-2 transition-all ${
        selectedMethod === 'billie'
          ? 'border-blue-600 bg-white dark:bg-gray-800'
          : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-500'
      }`}
    >
      <div class="w-10 h-10 bg-white dark:bg-gray-700 rounded-lg flex items-center justify-center border dark:border-gray-600">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="#007bff"/>
        </svg>
      </div>
      <span class="text-lg font-semibold text-slate-800 dark:text-slate-200">Billie</span>
    </button>
  </div>

  {#if error}
    <div class="bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-300 px-4 py-3 rounded mb-4">
      {error}
    </div>
  {/if}

  {#if isInitializing}
    <div class="flex items-center justify-center py-8">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      <span class="ml-2 text-gray-600 dark:text-gray-400">Initializing payment...</span>
    </div>
  {/if}

  <!-- Stripe Elements -->
  <div class="min-h-[200px]">
    <div id="payment-element" class={paymentElementClass}></div>
    <div id="address-element" class={addressElementClass}></div>
  </div>

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