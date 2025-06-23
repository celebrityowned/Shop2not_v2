// Tab switching functionality
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.getAttribute('data-tab')).classList.add('active');
    if (tab.getAttribute('data-tab') === 'collections') {
      loadCollections();
    }
  });
});

// --- 1. PROMISE-BASED HELPER ---
function sendMessageAsync(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.success) {
                resolve(response);
            } else {
                reject(new Error(response ? response.error : 'An unknown error occurred.'));
            }
        });
    });
}

let collections = {};

// Fetch collections from the background script
async function loadCollections() {
  try {
    const response = await sendMessageAsync({ action: 'getCollections' });
    collections = response.collections || {};
    updateCollectionActions();
  } catch (e) {
    console.error("Shop2not: Could not fetch collections for popup.", e.message);
  }
}

function updateCollectionActions() {
    const select = document.getElementById('collection-select');
    const actions = document.getElementById('collection-actions');
    const info = document.getElementById('collection-info');
    const nameInput = document.getElementById('new-collection-name');
    const createBtn = document.getElementById('create-collection');

    // Populate dropdown
    const previouslySelected = select.value;
    select.innerHTML = '<option value="">Select a collection...</option>';
    Object.keys(collections).sort().forEach(name => {
        select.add(new Option(name, name));
    });
    select.value = previouslySelected;
    
    // Toggle visibility
    const isACollectionSelected = select.value && collections[select.value];
    actions.style.display = isACollectionSelected ? 'block' : 'none';
    nameInput.style.display = isACollectionSelected ? 'none' : 'block';
    createBtn.style.display = isACollectionSelected ? 'none' : 'block';
    
    if (isACollectionSelected) {
        const collection = collections[select.value];
        info.textContent = `${collection.products.length} products \u2022 Created ${new Date(collection.createdAt).toLocaleDateString()}`;
    } else {
        info.textContent = '';
    }
}

document.getElementById('collection-select').addEventListener('change', updateCollectionActions);

// The "Create Collection" button now only opens the modal
document.getElementById('create-collection').addEventListener('click', () => {
    document.getElementById('new-collection-name').value = '';
    openModal();
});

document.getElementById('download-collection').addEventListener('click', async () => {
  const collectionName = document.getElementById('collection-select').value;
  if (!collectionName || !collections[collectionName]) return;
  const csv = generateCsv(collections[collectionName].products);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${collectionName.replace(/[^a-z0-9]/gi, '_')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById('delete-collection').addEventListener('click', async () => {
  const collectionName = document.getElementById('collection-select').value;
  if (!collectionName || !confirm(`Are you sure you want to delete "${collectionName}"?`)) return;
  
  try {
    const { collections } = await sendMessageAsync({ action: 'getCollections' });
    delete collections[collectionName];
    await sendMessageAsync({ action: 'saveCollections', collections });
    loadCollections(); // Reload and repaint the UI
  } catch (e) {
      alert(`Error deleting collection: ${e.message}`);
  }
});

// Main "Bulk Add" button also just opens the modal
document.getElementById('open-modal').addEventListener('click', openModal);

// This is the single, unified function to open the modal.
async function openModal() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const data = {};
    const dataFiles = ['whatnot_taxonomy.js', 'whatnot_conditions.js', 'whatnot_shipping.js'];
    
    for (const fileName of dataFiles) {
        const url = chrome.runtime.getURL(fileName);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${fileName}`);
        const text = await response.text();
        const objectStart = text.indexOf('{');
        const objectEnd = text.lastIndexOf('}');
        data[fileName.split('.')[0].split('_')[1]] = text.substring(objectStart, objectEnd + 1);
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (data) => {
        if (document.getElementById('__WHATNOT_EXTENSION_DATA__')) {
            document.getElementById('__WHATNOT_EXTENSION_DATA__').remove();
        }
        const dataDiv = document.createElement('div');
        dataDiv.id = '__WHATNOT_EXTENSION_DATA__';
        dataDiv.dataset.taxonomy = data.taxonomy;
        dataDiv.dataset.conditions = data.conditions;
        dataDiv.dataset.shipping = data.shipping;
        dataDiv.style.display = 'none';
        document.body.appendChild(dataDiv);

        if (document.getElementById('__WHATNOT_EXTENSION_COMMAND__')) {
            document.getElementById('__WHATNOT_EXTENSION_COMMAND__').remove();
        }
        const signalDiv = document.createElement('div');
        signalDiv.id = '__WHATNOT_EXTENSION_COMMAND__';
        document.body.appendChild(signalDiv);
      },
      args: [data]
    });

    window.close();
  } catch (error) {
    console.error('Popup script error:', error);
    alert(`A critical error occurred: ${error.message}.`);
  }
}

function generateCsv(products) {
  const headers = ["Category","Sub Category","Title","Description","Quantity","Type","Price","Shipping Profile","Offerable","Hazmat","Condition","Cost Per Item","SKU","Image URL 1","Image URL 2","Image URL 3","Image URL 4","Image URL 5","Image URL 6","Image URL 7","Image URL 8"];
  const csvRows = [headers.join(',')];
  products.forEach(product => {
    const quote = (val) => '"' + String(val).replace(/"/g, '""') + '"';
    let imageUrls = (product.images || []).map(img => img.src || img); // Handle both object and string arrays
    if(imageUrls.length === 0 && product.image) imageUrls.push(product.image);
    while (imageUrls.length < 8) imageUrls.push('');
    
    const row = [
      product.mainCategory || '', product.subCategory || '', product.title || '',
      product.description ? product.description.replace(/\r?\n|\r/g, ' ').replace(/"/g, '""') : '',
      product.quantity != null ? product.quantity : '1', product.type || '',
      product.price || '0.00', product.shippingProfile || '', 'Yes', 'No',
      product.condition || '', product.price || '0.00', product.sku || '',
      ...imageUrls.slice(0, 8)
    ].map(quote);
    csvRows.push(row.join(','));
  });
  return csvRows.join('\n');
}

// Initial load
loadCollections();