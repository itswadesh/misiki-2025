<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';

  let planId = '';
  let totalAmount = 0;
  let couponCode = '';

  let billingDetails = {
    name: '',
    email: '',
    address: {
      line1: '',
      line2: '',
      city: '',
      state: '',
      postal_code: '',
      country: 'DE' // Default to Germany for Billie
    }
  };

  let isLoading = false;
  let error = '';

  onMount(() => {
    const urlParams = new URLSearchParams($page.url.search);
    planId = urlParams.get('plan_id') || '';
    totalAmount = parseFloat(urlParams.get('total_amount') || '0');
    couponCode = urlParams.get('coupon') || '';
  });

  async function handleSubmit() {
    if (!billingDetails.name || !billingDetails.email || !billingDetails.address.line1 ||
        !billingDetails.address.city || !billingDetails.address.state ||
        !billingDetails.address.postal_code || !billingDetails.address.country) {
      error = 'Please fill in all required fields';
      return;
    }

    isLoading = true;
    error = '';

    try {
      const response = await fetch('/api/checkout/stripe-billie', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan_id: planId,
          total_amount: totalAmount,
          couponCode: couponCode || undefined,
          billing_details: billingDetails,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Payment successful
        goto('/orders'); // Or success page
      } else {
        error = result.error || 'Payment failed';
      }
    } catch (err) {
      error = 'An error occurred during payment';
      console.error(err);
    } finally {
      isLoading = false;
    }
  }
</script>

<div class="max-w-md mx-auto p-6 bg-white rounded-lg shadow-md">
  <h1 class="text-2xl font-bold mb-6">Pay with Billie</h1>

  {#if error}
    <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
      {error}
    </div>
  {/if}

  <form on:submit|preventDefault={handleSubmit} class="space-y-4">
    <div>
      <label for="name" class="block text-sm font-medium text-gray-700">Full Name *</label>
      <input
        type="text"
        id="name"
        bind:value={billingDetails.name}
        required
        class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
      />
    </div>

    <div>
      <label for="email" class="block text-sm font-medium text-gray-700">Email *</label>
      <input
        type="email"
        id="email"
        bind:value={billingDetails.email}
        required
        class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
      />
    </div>

    <div>
      <label for="line1" class="block text-sm font-medium text-gray-700">Address Line 1 *</label>
      <input
        type="text"
        id="line1"
        bind:value={billingDetails.address.line1}
        required
        class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
      />
    </div>

    <div>
      <label for="line2" class="block text-sm font-medium text-gray-700">Address Line 2</label>
      <input
        type="text"
        id="line2"
        bind:value={billingDetails.address.line2}
        class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
      />
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div>
        <label for="city" class="block text-sm font-medium text-gray-700">City *</label>
        <input
          type="text"
          id="city"
          bind:value={billingDetails.address.city}
          required
          class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      <div>
        <label for="state" class="block text-sm font-medium text-gray-700">State *</label>
        <input
          type="text"
          id="state"
          bind:value={billingDetails.address.state}
          required
          class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div>
        <label for="postal_code" class="block text-sm font-medium text-gray-700">Postal Code *</label>
        <input
          type="text"
          id="postal_code"
          bind:value={billingDetails.address.postal_code}
          required
          class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      <div>
        <label for="country" class="block text-sm font-medium text-gray-700">Country *</label>
        <select
          id="country"
          bind:value={billingDetails.address.country}
          required
          class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="DE">Germany</option>
          <option value="AT">Austria</option>
          <option value="CH">Switzerland</option>
        </select>
      </div>
    </div>

    <div class="bg-gray-50 p-4 rounded-md">
      <p class="text-sm text-gray-600">
        Plan: {planId}<br>
        Amount: €{totalAmount.toFixed(2)}
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
        Pay with Billie
      {/if}
    </button>
  </form>
</div>