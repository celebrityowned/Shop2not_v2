async function fetchProductJson(productId, storeBaseUrl) {
  const url = `${storeBaseUrl}/admin/products/${productId}.json`;
  console.log(`[Background] Fetching from: ${url}`);
  
  try {
    const response = await fetch(url, { credentials: 'include' });

    // Before parsing JSON, check if we received an HTML page (e.g., login page)
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.indexOf('application/json') === -1) {
      throw new Error(`Authentication failed. Expected JSON but received ${contentType}. You may need to log in to Shopify again.`);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Shopify API error: ${response.status}. Response: ${errorBody}`);
    }

    const data = await response.json();
    return { success: true, product: data.product };
  } catch (error) {
    console.error(`[Background] Error fetching product ${productId}:`, error);
    return { success: false, error: error.message };
  }
}

// Centralized Collection Management
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Existing listener for product details
  if (request.action === 'fetchProductDetails') {
    const adminUrl = new URL(sender.tab.url);
    const origin = adminUrl.origin;
    const storePathMatch = adminUrl.pathname.match(/^(\/store\/[^/]+)/);
    const storePath = storePathMatch ? storePathMatch[0] : '';
    const storeBaseUrl = `${origin}${storePath}`;

    fetchProductJson(request.productId, storeBaseUrl).then(sendResponse);
    return true; // Keep channel open for async response
  }

  // New listener to get all collections
  if (request.action === 'getCollections') {
    chrome.storage.local.get('collections', ({ collections = {} }) => {
      sendResponse({ success: true, collections });
    });
    return true; // Required for async sendResponse
  }

  // New listener to save collections
  if (request.action === 'saveCollections') {
    chrome.storage.local.set({ collections: request.collections }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true });
      }
    });
    return true; // Required for async sendResponse
  }
}); 