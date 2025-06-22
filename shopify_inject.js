/**
 * Shopify to Whatnot Chrome Extension
 *
 * Copyright (c) 2024 David Weinrot
 *
 * This script is the main entry point for the content script. It is responsible for
 * scraping product data from the page, loading data from the DOM, and then calling
 * the functions (defined in other files) to show the modal and generate the CSV.
 */

// --- CORE LOGIC ---

/**
 * Finds all selected product rows, scrapes their details directly from the page,
 * and returns an array of product data objects. This is more resilient to Shopify's
 * dynamic class names and DOM structure.
 * @returns {object[]} An array of product data objects.
 */
async function fetchProductJson(productId) {
  console.log(`fetchProductJson called for product ${productId}`);
  
  try {
    // Check if chrome.runtime is available
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      console.log(`Using background script for product ${productId}`);
      const response = await chrome.runtime.sendMessage({
        action: 'fetchProductDetails',
        productId: productId
      });
      
      console.log(`fetchProductJson received response for product ${productId}:`, response);
      
      if (response && response.success) {
        return response.product;
      } else {
        console.error(`fetchProductJson failed for product ${productId}:`, response?.error || 'Unknown error');
        throw new Error(response?.error || 'Failed to fetch product data');
      }
    } else {
      // Fallback: make direct API call from content script
      console.log(`Using direct API call for product ${productId}`);
      
      // Get the current page URL to determine the store base URL
      const currentUrl = window.location.href;
      const urlMatch = currentUrl.match(/^https:\/\/admin\.shopify\.com(\/store\/[^\/]+)/);
      if (!urlMatch) {
        throw new Error('Could not determine store URL from current page');
      }
      
      const storeBaseUrl = `https://admin.shopify.com${urlMatch[1]}`;
      const apiUrl = `${storeBaseUrl}/admin/products/${productId}.json`;
      
      console.log(`Making direct API call to: ${apiUrl}`);
      
      const response = await fetch(apiUrl, { 
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Shopify API error: ${response.status}. Response: ${errorText}`);
      }
      
      const data = await response.json();
      console.log(`Direct API call successful for product ${productId}:`, data);
      return data.product;
    }
  } catch (error) {
    console.error(`fetchProductJson error for product ${productId}:`, error);
    throw error;
  }
}

async function scrapeSelectedProductDetails() {
  console.log("Attempting to find selected product IDs...");

  const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');
  let selectedCheckboxes = Array.from(allCheckboxes).filter(cb => cb.checked);
  
  // Filter out the "select all" checkbox by checking if it's inside a column header.
  selectedCheckboxes = selectedCheckboxes.filter(cb => !cb.closest('div[role="columnheader"]'));

  if (selectedCheckboxes.length === 0) {
    console.log("No selected checkboxes found on the page.");
    return [];
  }

  console.log(`Found ${selectedCheckboxes.length} selected checkboxes. Extracting basic product details...`);
  
  const products = [];
  selectedCheckboxes.forEach(checkbox => {
    const row = checkbox.closest('div[role="row"], tr');
    if (!row) {
      console.warn("Could not find parent row for a checkbox.", checkbox);
      return;
    }
    const productLink = row.querySelector('a[href*="/products/"]');
    const imageEl = row.querySelector('img');
    const productTypeEl = Array.from(row.querySelectorAll('p, span, div')).find(el => el.textContent.trim().length > 1 && !el.querySelector('a'));
    
    if (productLink) {
      const idMatch = productLink.href.match(/\/products\/(\d+)/);
      if (idMatch && idMatch[1]) {
        products.push({
          id: idMatch[1],
          title: productLink.textContent.trim(),
          productType: productTypeEl ? productTypeEl.textContent.trim() : '',
          image: imageEl ? imageEl.src : '',
          // Placeholders for data to be fetched later
          description: '',
          price: '0.00',
          sku: '',
          quantity: 1,
          weight: 0,
          weightUnit: 'g'
        });
      }
    }
  });

  if (products.length === 0) {
    console.error("Found checked boxes but could not extract any product details.");
    return [];
  }
  
  console.log(`Successfully scraped basic details for ${products.length} products.`);
  return products;
}

// --- AI & NOMINATION LOGIC ---

/**
 * Parses the shipping profile names to find the best match for a given weight.
 * This function is designed to be robust and handle various formats from Whatnot.
 * @param {number} weightInGrams - The product weight from Shopify API.
 * @param {object} shippingProfiles - The whatnotShippingProfiles object.
 * @returns {string|null} The ID of the best matching shipping profile.
 */
function nominateShippingProfile(weightInGrams, shippingProfiles) {
  if (typeof weightInGrams !== 'number' || !shippingProfiles) return null;

  const g = weightInGrams;
  const oz = g * 0.035274;
  const lb = g * 0.00220462;
  
  for (const [id, name] of Object.entries(shippingProfiles)) {
    const nameLower = name.toLowerCase();

    // --- Ounces ---
    if (nameLower.includes('oz')) {
      if (nameLower.includes('sports singles')) { // Special case
        if (oz <= 3) return id;
        continue;
      }
      const ozMatch = name.match(/(\d+(\.\d+)?)-(\d+(\.\d+)?) oz/);
      if (ozMatch) {
        const min = parseFloat(ozMatch[1]);
        const max = parseFloat(ozMatch[3]);
        if (oz >= min && oz <= max) return id;
        continue;
      }
    }

    // --- Pounds ---
    if (nameLower.includes('lb')) {
      const singleLbMatch = name.match(/^(\d+) lb/);
      if (singleLbMatch) {
        const targetLb = parseInt(singleLbMatch[1]);
        // Check if weight is within a reasonable range of the single lb value, e.g., +/- half a pound
        if (Math.abs(lb - targetLb) < 0.5) return id;
        continue;
      }
      const lbMatch = name.match(/(\d+)-(\d+) lbs/);
      if (lbMatch) {
        const min = parseInt(lbMatch[1]);
        const max = parseInt(lbMatch[2]);
        if (lb >= min && lb <= max) return id;
        continue;
      }
    }

    // --- Grams / KGs ---
    if (nameLower.includes('gram') || nameLower.includes('kg')) {
      const gramMatch = name.match(/(\d+) to <(\d+) grams/);
      if (gramMatch) {
        const min = parseInt(gramMatch[1]);
        const max = parseInt(gramMatch[2]);
        if (g >= min && g < max) return id;
        continue;
      }
      const kgMatch = name.match(/(\d+) kgs? to <(\d+) kgs?/);
      if (kgMatch) {
        const min = parseInt(kgMatch[1]) * 1000;
        const max = parseInt(kgMatch[2]) * 1000;
        if (g >= min && g < max) return id;
        continue;
      }
       const singleKgMatch = name.match(/(\d+) grams to <(\d+) kgs/); // e.g. 750 grams to <1 KGs
      if (singleKgMatch) {
        const min = parseInt(singleKgMatch[1]);
        const max = parseInt(singleKgMatch[2]) * 1000;
        if (g >= min && g < max) return id;
        continue;
      }
    }
  }
  return null; // No match found
}

/**
 * Analyzes product title and type to suggest a category.
 * @param {string} title - The product title.
 * @param {string} productType - The product type.
 * @param {object} categories - The main categories object.
 * @returns {object} An object with { mainCategory, subCategory }
 */
function nominateCategory(title, productType, categories) {
    const nominations = { mainCategory: null, subCategory: null };
    if (!title && !productType) return nominations;

    const searchText = `${title.toLowerCase()} ${productType.toLowerCase()}`;
    let bestMatch = { score: 0, main: null, sub: null };

    for (const [mainCat, subCats] of Object.entries(categories)) {
        for (const subCat of subCats) {
            const mainLower = mainCat.toLowerCase();
            const subLower = subCat.toLowerCase();
            let score = 0;

            if (searchText.includes(subLower)) score += 2; // Strong match for subcategory
            if (searchText.includes(mainLower)) score += 1; // Weaker match for main category
            
            if (score > bestMatch.score) {
                bestMatch = { score, main: mainCat, sub: subCat };
            }
        }
    }

    if (bestMatch.score > 0) {
        nominations.mainCategory = bestMatch.main;
        nominations.subCategory = bestMatch.sub;
    }
    
    return nominations;
}

// --- MODAL AND UI ---

/**
 * Fetches full product details for each product and updates the modal row by row.
 * @param {object[]} products - The array of products with basic details.
 * @param {HTMLElement} tbody - The table body element to update.
 * @param {object} allData - The loaded data (categories, conditions, shipping).
 */
async function fetchAndFillProductDetails(products, tbody, allData) {
    console.log("Starting deferred product detail fetching...");
    
    for (const product of products) {
        console.log(`Fetching details for product ${product.id}...`);
        
        try {
            const row = tbody.querySelector(`tr[data-product-id="${product.id}"]`);
            if (!row) {
                console.warn(`Could not find row for product ${product.id}`);
                continue;
            }

            // Add retry logic for the API call
            let fullProduct = null;
            let retries = 3;
            
            while (retries > 0 && !fullProduct) {
                try {
                    console.log(`Attempting to fetch product ${product.id} (${retries} retries left)...`);
                    fullProduct = await fetchProductJson(product.id);
                    console.log(`Successfully fetched product ${product.id}:`, fullProduct);
                } catch (fetchError) {
                    console.warn(`Fetch attempt failed for product ${product.id}:`, fetchError);
                    retries--;
                    if (retries > 0) {
                        console.log(`Retrying in 1 second...`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } else {
                        throw fetchError;
                    }
                }
            }
            
            if (!fullProduct) {
                throw new Error("Failed to fetch product after all retries");
            }
            
            // --- Update the master product object with full details ---
            product.description = fullProduct.body_html;
            const variant = fullProduct.variants[0];
            if (variant && variant.price) {
                const parsedPrice = parseFloat(variant.price);
                product.price = isNaN(parsedPrice) ? 0 : Math.round(parsedPrice);
            } else {
                product.price = 0;
            }
            product.sku = fullProduct.variants[0] ? fullProduct.variants[0].sku : '';
            product.quantity = fullProduct.variants[0] ? fullProduct.variants[0].inventory_quantity : 1;
            product.weight = fullProduct.variants[0] ? fullProduct.variants[0].grams : 0;
            product.weightUnit = 'g';
            // Collect all image URLs
            if (fullProduct.images && Array.isArray(fullProduct.images)) {
                product.images = fullProduct.images.map(img => img.src).filter(Boolean);
            } else if (fullProduct.image && fullProduct.image.src) {
                product.images = [fullProduct.image.src];
            } else {
                product.images = [];
            }
            
            console.log(`Product ${product.id} details updated:`, {
                price: product.price,
                weight: product.weight,
                sku: product.sku,
                quantity: product.quantity,
                images: product.images
            });
            
            // --- AI Nominations (now with actual weight) ---
            const nominatedShippingId = nominateShippingProfile(product.weight, allData.whatnotShippingProfiles);
            const nominatedCategory = nominateCategory(product.title, product.productType, allData.categories);
            
            console.log(`AI nominations for product ${product.id}:`, {
                shippingId: nominatedShippingId,
                mainCategory: nominatedCategory.mainCategory,
                subCategory: nominatedCategory.subCategory
            });

            // --- Update UI Elements ---
            const priceInput = row.querySelector('[name="price"]');
            if (priceInput) {
                priceInput.value = product.price;
                priceInput.disabled = false;
                console.log(`Updated price for product ${product.id} to ${product.price}`);
            }

            const mainCatDropdown = row.querySelector('.main-category-dropdown');
            if (mainCatDropdown) {
                mainCatDropdown.value = nominatedCategory.mainCategory;
                mainCatDropdown.dispatchEvent(new Event('change', { bubbles: true }));
                console.log(`Set main category for product ${product.id} to ${nominatedCategory.mainCategory}`);
            }

            // A small delay to allow the sub-category dropdown to populate
            setTimeout(() => {
                const subCatDropdown = row.querySelector('.sub-category-dropdown');
                if (subCatDropdown) {
                    subCatDropdown.value = nominatedCategory.subCategory;
                    console.log(`Set sub category for product ${product.id} to ${nominatedCategory.subCategory}`);
                }
            }, 100);

            const shippingDropdown = row.querySelector('[name="shippingProfile"]');
            if (shippingDropdown) {
                shippingDropdown.value = nominatedShippingId;
                console.log(`Set shipping profile for product ${product.id} to ${nominatedShippingId}`);
            }

        } catch (error) {
            console.error(`Failed to fetch full details for product ${product.id}:`, error);
            const row = tbody.querySelector(`tr[data-product-id="${product.id}"]`);
            if (row) {
                row.classList.add('row-error');
                row.title = `Error: ${error.message}`;
            }
        }
    }
    
    console.log("Completed deferred product detail fetching.");
}

function showModal(products, categories, whatnotConditions, whatnotShippingProfiles) {
  // --- Cleanup old modal if it exists ---
  const existingOverlay = document.getElementById('whatnot-modal-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  // --- Create Modal Structure ---
  const overlay = document.createElement('div');
  overlay.id = 'whatnot-modal-overlay';
  overlay.className = 'whatnot-modal-overlay';
  
  const modal = document.createElement('div');
  modal.className = 'whatnot-modal';
  
  // --- Header ---
  const header = document.createElement('div');
  header.className = 'whatnot-modal-header';
  header.innerHTML = `
    <h2>Bulk Add to Whatnot (${products.length} products)</h2>
    <button id="whatnot-modal-close" class="whatnot-modal-close">&times;</button>
  `;
  modal.appendChild(header);
  
  // --- Table ---
  const table = document.createElement('table');
  table.className = 'whatnot-product-table';
  
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Product</th>
      <th>Main Category</th>
      <th>Sub Category</th>
      <th>Price</th>
      <th>Type</th>
      <th>Condition</th>
      <th>Shipping Profile</th>
    </tr>
  `;
  table.appendChild(thead);
  
  const tbody = document.createElement('tbody');
  products.forEach(product => {
    const truncatedTitle = product.title.length > 50 ? product.title.substring(0, 50) + '...' : product.title;
    const fullTitleAttr = product.title.replace(/"/g, '&quot;');

    const row = document.createElement('tr');
    row.dataset.productId = product.id;
    row.innerHTML = `
      <td class="product-info">
        <img src="${product.image}" class="product-thumbnail-small" alt="${product.title}">
        <div>
          <div class="product-title" title="${fullTitleAttr}">${truncatedTitle}</div>
          <div class="product-type">${product.productType}</div>
        </div>
      </td>
      <td>
        <select name="mainCategory" class="form-control main-category-dropdown">
          <option value="">Loading...</option>
          ${Object.keys(categories).sort().map(cat => `<option value="${cat}">${cat}</option>`).join('')}
        </select>
      </td>
      <td>
        <select name="subCategory" class="form-control sub-category-dropdown" style="display: none;">
          <option value="">Select...</option>
        </select>
      </td>
      <td>
        <input type="number" class="form-control" name="price" value="${product.price}" placeholder="e.g., 25.00">
      </td>
      <td>
        <select class="form-control" name="type">
          <option value="Auction" selected>Auction</option>
          <option value="Buy it Now">Buy it Now</option>
          <option value="Giveaway">Giveaway</option>
        </select>
      </td>
      <td>
        <select class="form-control" name="condition">
          <option value="">Loading...</option>
        </select>
      </td>
      <td>
        <select class="form-control" name="shippingProfile">
          <option value="">Loading...</option>
          ${Object.entries(whatnotShippingProfiles).map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}
        </select>
      </td>
    `;
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  modal.appendChild(table);
  
  // --- Footer with Action Button ---
  const footer = document.createElement('div');
  footer.className = 'whatnot-modal-footer';
  footer.innerHTML = `
    <button id="cancel-btn" class="whatnot-modal-cancel">Cancel</button>
    <button id="generate-csv-btn" class="whatnot-modal-confirm">Confirm & Push to Whatnot (${products.length})</button>
  `;
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // --- Start fetching full details after modal is shown ---
  fetchAndFillProductDetails(products, tbody, { categories, whatnotConditions, whatnotShippingProfiles });

  // --- Event Listeners ---
  const closeModal = () => {
    overlay.remove();
    // Clean up any remaining event listeners or state
    console.log("Modal closed and cleaned up");
  };

  document.getElementById('whatnot-modal-close').addEventListener('click', closeModal);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('generate-csv-btn').addEventListener('click', () => {
    generateCsv(products);
    closeModal();
  });
  
  // Close modal when clicking outside of it
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });
  
  tbody.addEventListener('change', e => {
    if (e.target.matches('.main-category-dropdown')) {
      const mainCategory = e.target.value;
      const row = e.target.closest('tr');
      const subCategoryDropdown = row.querySelector('.sub-category-dropdown');
      const conditionDropdown = row.querySelector('[name="condition"]');
      
      // Update subcategory dropdown
      subCategoryDropdown.innerHTML = '<option value="">Select...</option>';
      
      if (mainCategory && categories[mainCategory] && categories[mainCategory].length > 0) {
        const subCategories = categories[mainCategory];
        subCategories.forEach(sub => {
          subCategoryDropdown.add(new Option(sub, sub));
        });
        subCategoryDropdown.style.display = 'block';
      } else {
        subCategoryDropdown.style.display = 'none';
      }
      
      // Update condition dropdown based on selected category
      conditionDropdown.innerHTML = '<option value="">Select...</option>';
      if (mainCategory && whatnotConditions[mainCategory]) {
        const conditions = whatnotConditions[mainCategory];
        conditions.forEach(condition => {
          conditionDropdown.add(new Option(condition, condition));
        });
      }
    } else if (e.target.matches('.sub-category-dropdown')) {
      // For future use: if you want conditions to be dependent on subcategory as well
      // Currently conditions are only dependent on main category
    }
  });
}

/**
 * Gathers all data from the modal forms, formats it as a CSV string,
 * and triggers a download.
 * @param {object[]} products - The original array of scraped products.
 */
function generateCsv(products) {
    console.log("Generating CSV for table view...");
    const headers = [
        "Category",
        "Sub Category",
        "Title",
        "Description",
        "Quantity",
        "Type",
        "Price",
        "Shipping Profile",
        "Offerable",
        "Hazmat",
        "Condition",
        "Cost Per Item",
        "SKU",
        "Image URL 1",
        "Image URL 2",
        "Image URL 3",
        "Image URL 4",
        "Image URL 5",
        "Image URL 6",
        "Image URL 7",
        "Image URL 8"
    ];
    const rows = [];

    const tbody = document.querySelector('.whatnot-product-table tbody');
    if (!tbody) {
        console.error("Could not find table body for CSV generation");
        return;
    }

    // Helper to quote CSV fields
    const quote = (val) => '"' + String(val).replace(/"/g, '""') + '"';

    tbody.querySelectorAll('tr').forEach(row => {
        const productId = row.dataset.productId;
        const product = products.find(p => p.id.toString() === productId);
        if (!product) {
            console.warn(`Could not find original product data for ID ${productId}`);
            return;
        }
        
        const getVal = (name) => {
            const el = row.querySelector(`[name=${name}]`);
            return el ? el.value : '';
        };

        // Category and Sub Category from modal dropdowns
        const mainCat = getVal('mainCategory');
        const subCat = getVal('subCategory');
        // Title and Description
        const title = product.title || '';
        const description = product.description ? product.description.replace(/\r?\n|\r/g, ' ').replace(/"/g, '""') : '';
        // Quantity, Type, Price
        const quantity = product.quantity != null ? product.quantity : '1';
        const type = getVal('type');
        const price = getVal('price');
        // Shipping Profile (human-readable)
        const shippingDropdown = row.querySelector('[name="shippingProfile"]');
        let shippingProfile = '';
        if (shippingDropdown) {
            const selectedOption = shippingDropdown.options[shippingDropdown.selectedIndex];
            shippingProfile = selectedOption ? selectedOption.text : '';
        }
        // Offerable, Hazmat
        const offerable = 'Yes';
        const hazmat = 'No';
        // Condition from modal
        const condition = getVal('condition');
        // Cost Per Item (same as price)
        const costPerItem = price;
        // SKU from product
        const sku = product.sku || '';
        // Image URLs (up to 8)
        let imageUrls = [];
        if (product.images && Array.isArray(product.images)) {
            imageUrls = product.images.slice(0, 8);
        } else if (product.image) {
            imageUrls = [product.image];
        }
        while (imageUrls.length < 8) imageUrls.push('');

        rows.push([
            mainCat,
            subCat,
            title,
            description,
            quantity,
            type,
            price,
            shippingProfile,
            offerable,
            hazmat,
            condition,
            costPerItem,
            sku,
            ...imageUrls
        ].map(quote).join(','));
    });

    let csvContent = headers.map(quote).join(",") + "\n" + rows.join("\n");
    
    // Generate timestamp for filename
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${year}${month}${day}_${hours}${minutes}${seconds}`;
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const link = document.createElement("a");
    link.setAttribute("href", URL.createObjectURL(blob));
    link.setAttribute("download", `whatnot_export_${timestamp}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    
    console.log("CSV generated and downloaded successfully");
}

/**
 * Reads the data injected into the DOM by the popup script.
 * @returns {object|null} An object containing all the necessary data, or null on failure.
 */
function loadDataFromDOM() {
  try {
    const dataDiv = document.getElementById('__WHATNOT_EXTENSION_DATA__');
    if (!dataDiv) throw new Error('Data container div not found.');

    const taxonomyString = dataDiv.dataset.taxonomy;
    const conditionsString = dataDiv.dataset.conditions;
    const shippingString = dataDiv.dataset.shipping;
    
    if (!taxonomyString || !conditionsString || !shippingString) {
      throw new Error('One or more data attributes are missing from the data div.');
    }
    
    // Parse all data
    const categories = JSON.parse(taxonomyString);
    const whatnotConditions = JSON.parse(conditionsString);
    const whatnotShippingProfiles = JSON.parse(shippingString);

    dataDiv.remove(); // Cleanup
    console.log("All data successfully loaded and parsed from DOM.");
    
    return { categories, whatnotConditions, whatnotShippingProfiles };
    
  } catch (error) {
    console.error("Critical error loading data from DOM:", error);
    alert("CRITICAL: Failed to load necessary data from the DOM. The extension cannot function.");
    return null;
  }
}

// --- MAIN EXECUTION ---

/**
 * The main function to orchestrate the entire process.
 */
async function start() {
  const products = await scrapeSelectedProductDetails();
  
  if (products.length === 0) {
    alert("No products selected, or could not read product details. Please select at least one product and try again.");
    return;
  }
  
  const allData = loadDataFromDOM();
  if (!allData) {
    return; // Error is alerted within loadDataFromDOM
  }

  // All data is loaded, now call the modal function which is defined in modal.js
  showModal(products, allData.categories, allData.whatnotConditions, allData.whatnotShippingProfiles);
}

/**
 * Initializes a poller that waits for a command from the popup.
 * This is the entry point of the script.
 */
function initializeCommandPolling() {
  console.log("Whatnot extension inject script loaded. Polling for command...");
  const poller = setInterval(() => {
    const commandDiv = document.getElementById('__WHATNOT_EXTENSION_COMMAND__');
    if (commandDiv) {
      console.log("Command received from popup.");
      clearInterval(poller);
      commandDiv.remove(); // Clean up the command div
      start(); // Start the main logic
    }
  }, 500); // Check every 500ms
}

initializeCommandPolling();