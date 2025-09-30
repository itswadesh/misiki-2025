<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head>
  <title>{page.status} - Misiki</title>
</svelte:head>

<div class="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-700 flex items-center justify-center px-4">
  <div class="text-center">
    <div class="mb-8">
      <h1 class="text-6xl font-bold text-gray-900 dark:text-white mb-4">{page.status}</h1>
      <h2 class="text-2xl font-semibold text-gray-700 dark:text-gray-300 mb-4">
        {#if page.status === 404}
          Page Not Found
        {:else}
          Something went wrong
        {/if}
      </h2>
      <p class="text-gray-600 dark:text-gray-400 mb-8 max-w-md mx-auto">
        {#if page.status === 404}
          The page you're looking for doesn't exist or has been moved.
        {:else}
          We encountered an error while processing your request.
        {/if}
      </p>
    </div>

    <div class="space-y-4">
      <a
        href="/"
        class="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors duration-200"
      >
        Go Home
      </a>
      <br>
      <button
        onclick={() => window.history.back()}
        class="inline-block bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-medium py-2 px-4 rounded-lg transition-colors duration-200"
      >
        Go Back
      </button>
    </div>
  </div>
</div>