document.getElementById('open-modal').addEventListener('click', async () => {
  try {
    console.log('Button clicked. Fetching all data files...');

    // Helper to fetch a file and extract its JS object as a string.
    const fetchDataFile = async (fileName) => {
      const url = chrome.runtime.getURL(fileName);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch ${fileName}: ${response.statusText}`);
      const text = await response.text();
      
      // Find the object literal and extract it to ensure it's valid JSON
      const objectStart = text.indexOf('{');
      const objectEnd = text.lastIndexOf('}');
      if (objectStart === -1 || objectEnd === -1) {
        throw new Error(`Could not find a valid object in ${fileName}`);
      }
      return text.substring(objectStart, objectEnd + 1);
    };
    
    // Fetch all data in parallel
    const [taxonomyString, conditionsString, shippingString] = await Promise.all([
      fetchDataFile('whatnot_taxonomy.js'),
      fetchDataFile('whatnot_conditions.js'),
      fetchDataFile('whatnot_shipping.js')
    ]);

    console.log('All data fetched. Injecting into DOM...');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (data) => {
        // Remove old data div if it exists
        const oldDataDiv = document.getElementById('__WHATNOT_EXTENSION_DATA__');
        if(oldDataDiv) oldDataDiv.remove();

        // Inject a single data holder div
        const dataDiv = document.createElement('div');
        dataDiv.id = '__WHATNOT_EXTENSION_DATA__';
        dataDiv.dataset.taxonomy = data.taxonomy;
        dataDiv.dataset.conditions = data.conditions;
        dataDiv.dataset.shipping = data.shipping;
        dataDiv.style.display = 'none';
        document.body.appendChild(dataDiv);
        console.log('Data div injected.');

        // Inject command signal div
        const signalDiv = document.createElement('div');
        signalDiv.id = '__WHATNOT_EXTENSION_COMMAND__';
        signalDiv.style.display = 'none';
        document.body.appendChild(signalDiv);
        console.log('Signal div injected.');
      },
      args: [{
        taxonomy: taxonomyString,
        conditions: conditionsString,
        shipping: shippingString
      }]
    });

    window.close();
  } catch (error) {
    console.error('Popup script error:', error);
    alert(`A critical error occurred in the popup: ${error.message}. Please check the popup console for details.`);
  }
});