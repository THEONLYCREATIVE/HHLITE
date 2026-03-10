/**
 * EXPIRY TRACKER v6.1.0
 * Complete Pharmacy Expiry Tracking PWA
 * 
 * FEATURES:
 * - GS1 Parser: Extracts GTIN, Expiry (AI 17), Batch (AI 10)
 * - Multi-Scan Mode: If GTIN not in master, scan again for product barcode
 * - Master DB Matching: GTIN-14, GTIN-13, RMS, Custom barcodes
 * - API Fallback: Open Food Facts, UPC Item DB
 * - Cloud & Local Backup
 * 
 * By VYSAKH
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  DB_NAME: 'ExpiryTrackerDB',
  DB_VERSION: 3,
  EXPIRY_SOON_DAYS: 90,
  VERSION: '6.1.0'
};

// ============================================
// APPLICATION STATE
// ============================================
const App = {
  db: null,
  masterIndex: new Map(),      // barcode -> {name, rms}
  masterRMS: new Map(),        // RMS -> {name, barcode}
  masterVariants: new Map(),   // All variants -> {name, rms}
  settings: {
    apiEnabled: true
  },
  scanner: {
    active: false,
    instance: null,
    cameras: [],
    currentCamera: 0
  },
  filter: 'all',
  search: '',
  
  // PENDING ITEM - For multi-scan mode
  pendingItem: null,  // Holds GS1 data while waiting for product scan
  scanMode: 'normal'  // 'normal' or 'product' (waiting for product barcode)
};

// ============================================
// DATABASE LAYER
// ============================================
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      
      request.onerror = () => reject(request.error);
      
      request.onsuccess = () => {
        App.db = request.result;
        console.log('✅ Database ready');
        resolve();
      };
      
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          historyStore.createIndex('gtin', 'gtin', { unique: false });
          historyStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('master')) {
          const masterStore = db.createObjectStore('master', { keyPath: 'barcode' });
          masterStore.createIndex('name', 'name', { unique: false });
          masterStore.createIndex('rms', 'rms', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        
        console.log('📦 Database upgraded');
      };
    });
  },

  async _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction(store, mode);
      const s = tx.objectStore(store);
      const result = fn(s);
      if (result && result.onsuccess !== undefined) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      }
    });
  },

  // History operations
  async addHistory(item) {
    item.timestamp = item.timestamp || Date.now();
    return this._tx('history', 'readwrite', s => s.add(item));
  },
  
  async updateHistory(item) {
    return this._tx('history', 'readwrite', s => s.put(item));
  },
  
  async getHistory(id) {
    return this._tx('history', 'readonly', s => s.get(id));
  },
  
  async getAllHistory() {
    return this._tx('history', 'readonly', s => s.getAll());
  },
  
  async deleteHistory(id) {
    return this._tx('history', 'readwrite', s => s.delete(id));
  },
  
  async clearHistory() {
    return this._tx('history', 'readwrite', s => s.clear());
  },

  // Master operations
  async addMaster(item) {
    return this._tx('master', 'readwrite', s => s.put(item));
  },
  
  async getAllMaster() {
    return this._tx('master', 'readonly', s => s.getAll());
  },
  
  async clearMaster() {
    return this._tx('master', 'readwrite', s => s.clear());
  },
  
  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      let count = 0;
      
      for (const item of items) {
        if (item.barcode) {
          store.put(item);
          count++;
        }
      }
      
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  },

  // Settings
  async getSetting(key, defaultValue = null) {
    try {
      const result = await this._tx('settings', 'readonly', s => s.get(key));
      return result ? result.value : defaultValue;
    } catch {
      return defaultValue;
    }
  },
  
  async setSetting(key, value) {
    return this._tx('settings', 'readwrite', s => s.put({ key, value }));
  },

  // Export all data
  async exportAll() {
    const history = await this.getAllHistory();
    const master = await this.getAllMaster();
    return {
      version: CONFIG.VERSION,
      timestamp: Date.now(),
      history,
      master
    };
  },

  // Import all data
  async importAll(data) {
    if (data.history) {
      await this.clearHistory();
      for (const item of data.history) {
        delete item.id;
        await this.addHistory(item);
      }
    }
    if (data.master) {
      await this.bulkAddMaster(data.master);
    }
  }
};

// ============================================
// GS1 BARCODE PARSER - ROBUST VERSION
// ============================================
const GS1 = {
  /**
   * FNC1 character variants from different scanners
   */
  FNC1_CHARS: ['\u001d', '\u001e', '\u001c', '~'],
  
  /**
   * Symbology prefixes to remove
   */
  PREFIXES: [']C1', ']e0', ']E0', ']d2', ']Q3', ']J1', ']I1'],

  /**
   * Parse any barcode - GS1 or simple
   */
  parse(code) {
    const result = {
      raw: code || '',
      gtin: '',
      expiry: '',
      expiryISO: '',
      expiryDisplay: '',
      batch: '',
      serial: '',
      qty: 1,
      isGS1: false,
      parseMethod: 'unknown'
    };

    if (!code || typeof code !== 'string') return result;
    
    code = code.trim();
    
    // Remove symbology prefixes
    for (const prefix of this.PREFIXES) {
      if (code.startsWith(prefix)) {
        code = code.substring(prefix.length);
        break;
      }
    }
    
    // Normalize FNC1 characters
    for (const char of this.FNC1_CHARS) {
      code = code.split(char).join('\u001d');
    }
    code = code.replace(/\[FNC1\]|<GS>|\{GS\}/gi, '\u001d');

    // Detect if GS1 format
    const isGS1 = this.isGS1Format(code);
    
    if (isGS1) {
      result.isGS1 = true;
      result.parseMethod = 'gs1';
      this.parseGS1(code, result);
    } else {
      result.parseMethod = 'simple';
      this.parseSimple(code, result);
    }
    
    // Normalize GTIN
    if (result.gtin) {
      result.gtin = this.normalizeGTIN(result.gtin);
    }
    
    console.log('📊 Parsed:', {
      input: code.substring(0, 40) + (code.length > 40 ? '...' : ''),
      gtin: result.gtin,
      expiry: result.expiryISO,
      batch: result.batch,
      method: result.parseMethod
    });
    
    return result;
  },

  /**
   * Check if barcode is GS1 format
   */
  isGS1Format(code) {
    // Has GS separator
    if (code.includes('\u001d')) return true;
    // Has parentheses AI format
    if (/\(\d{2,4}\)/.test(code)) return true;
    // Starts with common GS1 AIs
    if (/^(01|02|10|11|17|21)\d/.test(code) && code.length > 16) return true;
    return false;
  },

  /**
   * Parse GS1-128 / DataMatrix format
   */
  parseGS1(code, result) {
    const GS = '\u001d';
    
    // Method 1: Parentheses format (01)12345678901234(17)231231(10)BATCH
    if (code.includes('(')) {
      const gtinMatch = code.match(/\(01\)(\d{14})/);
      if (gtinMatch) result.gtin = gtinMatch[1];
      
      const expiryMatch = code.match(/\(17\)(\d{6})/);
      if (expiryMatch) this.parseExpiryDate(expiryMatch[1], result);
      
      const batchMatch = code.match(/\(10\)([^\(]+)/);
      if (batchMatch) result.batch = batchMatch[1].trim();
      
      const serialMatch = code.match(/\(21\)([^\(]+)/);
      if (serialMatch) result.serial = serialMatch[1].trim();
      
      return;
    }
    
    // Method 2: Raw AI format 011234567890123417231231<GS>10BATCH
    let pos = 0;
    const len = code.length;
    
    while (pos < len) {
      // Skip GS
      if (code[pos] === GS) { pos++; continue; }
      
      // Try to match AI
      const ai2 = code.substring(pos, pos + 2);
      
      switch (ai2) {
        case '01': // GTIN (14 digits)
          result.gtin = code.substring(pos + 2, pos + 16);
          pos += 16;
          break;
          
        case '02': // Content GTIN (14 digits)
          if (!result.gtin) result.gtin = code.substring(pos + 2, pos + 16);
          pos += 16;
          break;
          
        case '17': // Expiry (6 digits YYMMDD)
        case '15': // Best before
        case '16': // Sell by
          this.parseExpiryDate(code.substring(pos + 2, pos + 8), result);
          pos += 8;
          break;
          
        case '11': // Production date
        case '12': // Due date
        case '13': // Pack date
          pos += 8; // Skip, we don't need production date
          break;
          
        case '10': // Batch (variable, ends at GS or end)
          pos += 2;
          let batch = '';
          while (pos < len && code[pos] !== GS) {
            batch += code[pos++];
          }
          result.batch = batch.substring(0, 20);
          break;
          
        case '21': // Serial (variable)
          pos += 2;
          let serial = '';
          while (pos < len && code[pos] !== GS) {
            serial += code[pos++];
          }
          result.serial = serial.substring(0, 20);
          break;
          
        case '30': // Quantity (variable)
        case '37':
          pos += 2;
          let qty = '';
          while (pos < len && code[pos] !== GS && /\d/.test(code[pos])) {
            qty += code[pos++];
          }
          result.qty = parseInt(qty, 10) || 1;
          break;
          
        default:
          pos++; // Move forward if no AI matched
      }
    }
  },

  /**
   * Parse simple barcode (EAN-13, UPC-A, etc.)
   */
  parseSimple(code, result) {
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 14) {
      result.gtin = digits;
    }
  },

  /**
   * Parse YYMMDD expiry date
   */
  parseExpiryDate(yymmdd, result) {
    if (!yymmdd || yymmdd.length !== 6) return;
    
    const yy = parseInt(yymmdd.substring(0, 2), 10);
    const mm = parseInt(yymmdd.substring(2, 4), 10);
    let dd = parseInt(yymmdd.substring(4, 6), 10);
    
    if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return;
    if (mm < 1 || mm > 12) return;
    
    // Century: 51-99 = 1900s, 00-50 = 2000s
    const year = yy >= 51 ? 1900 + yy : 2000 + yy;
    
    // Day 00 = end of month
    if (dd === 0) {
      dd = new Date(year, mm, 0).getDate();
    }
    
    result.expiry = yymmdd;
    result.expiryISO = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    result.expiryDisplay = `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`;
  },

  /**
   * Normalize GTIN to standard format
   */
  normalizeGTIN(gtin) {
    if (!gtin) return '';
    let clean = gtin.replace(/\D/g, '');
    
    // Remove excessive leading zeros
    while (clean.length > 14 && clean.startsWith('0')) {
      clean = clean.substring(1);
    }
    
    // Truncate if too long
    if (clean.length > 14) clean = clean.substring(0, 14);
    
    // Pad to 14 digits
    return clean.padStart(14, '0');
  },

  /**
   * Generate all GTIN variants for matching
   */
  generateVariants(gtin) {
    if (!gtin) return [];
    
    const clean = this.normalizeGTIN(gtin);
    if (!clean || clean.length < 8) return [];
    
    const variants = new Set();
    
    // Original
    variants.add(clean);
    
    // GTIN-14
    const gtin14 = clean.padStart(14, '0');
    variants.add(gtin14);
    
    // GTIN-13 (remove leading 0)
    if (gtin14.startsWith('0')) {
      variants.add(gtin14.substring(1));
    }
    
    // GTIN-12 (remove leading 00)
    if (gtin14.startsWith('00')) {
      variants.add(gtin14.substring(2));
    }
    
    // Last 13, 12, 8 digits
    if (clean.length >= 13) variants.add(clean.slice(-13));
    if (clean.length >= 12) variants.add(clean.slice(-12));
    if (clean.length >= 8) variants.add(clean.slice(-8));
    
    // Without leading zeros
    const noLeadingZeros = clean.replace(/^0+/, '');
    if (noLeadingZeros.length >= 8) variants.add(noLeadingZeros);
    
    return Array.from(variants);
  },

  /**
   * Get expiry status
   */
  getExpiryStatus(expiryISO) {
    if (!expiryISO) return 'unknown';
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const expiry = new Date(expiryISO);
    expiry.setHours(0, 0, 0, 0);
    
    const diffDays = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) return 'expired';
    if (diffDays <= CONFIG.EXPIRY_SOON_DAYS) return 'expiring';
    return 'ok';
  },

  /**
   * Get days until expiry
   */
  getDaysUntil(expiryISO) {
    if (!expiryISO) return Infinity;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const expiry = new Date(expiryISO);
    expiry.setHours(0, 0, 0, 0);
    
    return Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
  }
};

// ============================================
// PRODUCT MATCHING - MULTI-FORMAT SUPPORT
// ============================================
const Matcher = {
  /**
   * Build index from master data with all variants
   */
  buildIndex(masterData) {
    App.masterIndex.clear();
    App.masterRMS.clear();
    App.masterVariants.clear();
    
    for (const item of masterData) {
      const barcode = String(item.barcode || '').trim();
      const name = (item.name || '').trim();
      const rms = (item.rms || '').trim();
      
      if (!barcode || barcode.length < 8) continue;
      
      const cleanBarcode = barcode.replace(/\D/g, '');
      const product = { name, rms, barcode: cleanBarcode };
      
      // Store original
      App.masterIndex.set(cleanBarcode, product);
      
      // Generate and store all variants
      const variants = GS1.generateVariants(cleanBarcode);
      for (const v of variants) {
        if (!App.masterVariants.has(v)) {
          App.masterVariants.set(v, product);
        }
      }
      
      // Index by RMS
      if (rms) {
        App.masterRMS.set(rms, product);
        App.masterRMS.set(rms.replace(/\D/g, ''), product);
      }
    }
    
    console.log(`📋 Index: ${App.masterIndex.size} products, ${App.masterVariants.size} variants, ${App.masterRMS.size} RMS`);
  },

  /**
   * Find product by any identifier (GTIN, barcode, RMS)
   */
  find(code) {
    if (!code) return null;
    
    const clean = code.replace(/\D/g, '');
    if (clean.length < 4) return null;
    
    // Strategy 1: Check variants index
    const variants = GS1.generateVariants(clean);
    for (const v of variants) {
      if (App.masterVariants.has(v)) {
        console.log(`✅ Match via variant: ${v}`);
        return { ...App.masterVariants.get(v), matchType: 'GTIN' };
      }
    }
    
    // Strategy 2: Check RMS
    if (App.masterRMS.has(clean)) {
      console.log(`✅ Match via RMS: ${clean}`);
      return { ...App.masterRMS.get(clean), matchType: 'RMS' };
    }
    
    // Strategy 3: Direct master index
    if (App.masterIndex.has(clean)) {
      console.log(`✅ Match via direct: ${clean}`);
      return { ...App.masterIndex.get(clean), matchType: 'DIRECT' };
    }
    
    // Strategy 4: Partial match (last 8 digits)
    const last8 = clean.slice(-8);
    for (const [key, product] of App.masterIndex) {
      if (key.endsWith(last8) || key.slice(-8) === last8) {
        console.log(`✅ Match via last8: ${last8}`);
        return { ...product, matchType: 'PARTIAL' };
      }
    }
    
    console.log(`❌ No match for: ${clean}`);
    return null;
  }
};

// ============================================
// EXTERNAL API LOOKUPS
// ============================================
const API = {
  async lookup(gtin) {
    if (!App.settings.apiEnabled || !navigator.onLine) return null;
    
    const clean = GS1.normalizeGTIN(gtin);
    console.log(`🌐 API lookup: ${clean}`);
    
    // Try multiple GTIN formats
    const gtinsToTry = [clean, clean.slice(1), clean.slice(2)].filter(g => g.length >= 8);
    
    for (const g of gtinsToTry) {
      // Try Open Food Facts
      let result = await this.openFoodFacts(g);
      if (result) return result;
      
      // Try UPC Item DB
      result = await this.upcItemDb(g);
      if (result) return result;
      
      // Try Brocade
      result = await this.brocade(g);
      if (result) return result;
    }
    
    return null;
  },

  async openFoodFacts(gtin) {
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${gtin}.json`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      if (data.status === 1 && data.product?.product_name) {
        console.log(`  ✅ OFF: ${data.product.product_name}`);
        return { name: data.product.product_name, source: 'OpenFoodFacts' };
      }
    } catch (e) {
      console.log(`  ⚠️ OFF error: ${e.message}`);
    }
    return null;
  },

  async upcItemDb(gtin) {
    try {
      const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${gtin}`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      if (data.code === 'OK' && data.items?.[0]?.title) {
        console.log(`  ✅ UPC: ${data.items[0].title}`);
        return { name: data.items[0].title, source: 'UPCitemdb' };
      }
    } catch (e) {
      console.log(`  ⚠️ UPC error: ${e.message}`);
    }
    return null;
  },

  async brocade(gtin) {
    try {
      const res = await fetch(`https://www.brocade.io/api/items/${gtin}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.name) {
        console.log(`  ✅ Brocade: ${data.name}`);
        return { name: data.name, source: 'Brocade' };
      }
    } catch (e) {
      console.log(`  ⚠️ Brocade error: ${e.message}`);
    }
    return null;
  }
};

// ============================================
// BARCODE PROCESSING - WITH MULTI-SCAN MODE
// ============================================

/**
 * Main barcode processing function
 * 
 * LOGIC:
 * 1. Parse barcode (GS1 or simple)
 * 2. Extract GTIN, Expiry, Batch
 * 3. Try to find product name in master DB
 * 4. If NOT FOUND:
 *    - Show prompt to scan product barcode OR enter manually
 *    - Wait for second scan
 * 5. Save to history
 */
async function processBarcode(code, options = {}) {
  const { silent = false, skipRefresh = false, isProductScan = false } = options;
  
  if (!code || typeof code !== 'string') return null;
  code = code.trim();
  if (!code) return null;
  
  console.log('\n═══════════════════════════════════════');
  console.log(`🔍 Processing: ${code}`);
  console.log(`   Mode: ${isProductScan ? 'PRODUCT SCAN' : 'NORMAL'}`);
  console.log('═══════════════════════════════════════');
  
  // =========================================
  // MODE 1: PRODUCT SCAN (Second scan for name)
  // =========================================
  if (isProductScan && App.pendingItem) {
    return await completeWithProductScan(code, options);
  }
  
  // =========================================
  // MODE 2: NORMAL SCAN
  // =========================================
  
  // Parse the barcode
  const parsed = GS1.parse(code);
  
  // If no GTIN extracted, try using raw code
  if (!parsed.gtin) {
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 8) {
      parsed.gtin = GS1.normalizeGTIN(digits);
    } else {
      if (!silent) toast('Invalid barcode', 'warning');
      return null;
    }
  }
  
  // Try to find product in master database
  let product = Matcher.find(parsed.gtin);
  
  // If found, save and done
  if (product && product.name) {
    return await saveItem(parsed, product, options);
  }
  
  // Try API lookup
  if (App.settings.apiEnabled && navigator.onLine) {
    const apiResult = await API.lookup(parsed.gtin);
    if (apiResult) {
      product = { name: apiResult.name, rms: '', matchType: 'API' };
      
      // Save to master for future lookups
      await DB.addMaster({
        barcode: parsed.gtin,
        name: apiResult.name,
        rms: ''
      });
      await refreshMasterCount();
      
      return await saveItem(parsed, product, options);
    }
  }
  
  // =========================================
  // PRODUCT NOT FOUND - Enter multi-scan mode
  // =========================================
  console.log('❌ Product not found - entering multi-scan mode');
  
  // Store pending item
  App.pendingItem = {
    ...parsed,
    timestamp: Date.now()
  };
  App.scanMode = 'product';
  
  // Show product scan prompt
  showProductScanPrompt(parsed);
  
  if (!silent) {
    vibrate('medium');
  }
  
  return null;
}

/**
 * Complete item with product barcode scan
 */
async function completeWithProductScan(code, options = {}) {
  const { silent = false, skipRefresh = false } = options;
  
  console.log(`🔗 Product scan: ${code}`);
  
  // Parse the product barcode
  const productParsed = GS1.parse(code);
  const productCode = productParsed.gtin || code.replace(/\D/g, '');
  
  // Try to find product
  let product = Matcher.find(productCode);
  
  // Also try the raw code as RMS
  if (!product || !product.name) {
    product = Matcher.find(code);
  }
  
  // If still not found, try API
  if ((!product || !product.name) && App.settings.apiEnabled && navigator.onLine) {
    const apiResult = await API.lookup(productCode);
    if (apiResult) {
      product = { name: apiResult.name, rms: '', matchType: 'API' };
    }
  }
  
  // If still no product, allow manual entry
  if (!product || !product.name) {
    hideProductScanPrompt();
    showManualEntryModal(App.pendingItem, productCode);
    return null;
  }
  
  // We have the product! Save the item
  const pendingItem = App.pendingItem;
  clearPendingItem();
  hideProductScanPrompt();
  
  return await saveItem(pendingItem, product, options);
}

/**
 * Save item to history
 */
async function saveItem(parsed, product, options = {}) {
  const { silent = false, skipRefresh = false } = options;
  
  const entry = {
    raw: parsed.raw,
    gtin: parsed.gtin,
    name: product.name || 'Unknown Product',
    rms: product.rms || '',
    matchType: product.matchType || 'UNKNOWN',
    expiry: parsed.expiry,
    expiryISO: parsed.expiryISO,
    expiryDisplay: parsed.expiryDisplay,
    batch: parsed.batch,
    serial: parsed.serial,
    qty: parsed.qty || 1,
    supplier: '',
    returnable: '',
    timestamp: Date.now()
  };
  
  console.log('💾 Saving:', entry);
  
  const id = await DB.addHistory(entry);
  entry.id = id;
  
  if (!silent) {
    if (product.matchType === 'API') {
      toast(`Found via API: ${entry.name}`, 'success');
    } else {
      toast(`Added: ${entry.name}`, 'success');
    }
    vibrate('success');
  }
  
  if (!skipRefresh) {
    await refreshUI();
  }
  
  // Clear input
  const input = document.getElementById('inputBarcode');
  if (input) input.value = '';
  
  return entry;
}

/**
 * Show product scan prompt
 */
function showProductScanPrompt(parsed) {
  const promptEl = document.getElementById('productScanPrompt');
  const gtinEl = document.getElementById('promptGtin');
  const expiryEl = document.getElementById('promptExpiry');
  const batchEl = document.getElementById('promptBatch');
  
  if (gtinEl) gtinEl.textContent = parsed.gtin || '-';
  if (expiryEl) expiryEl.textContent = parsed.expiryDisplay || '-';
  if (batchEl) batchEl.textContent = parsed.batch || '-';
  
  if (promptEl) promptEl.classList.add('active');
  
  // Focus input for next scan
  const input = document.getElementById('inputBarcode');
  if (input) {
    input.value = '';
    input.placeholder = 'Scan PRODUCT barcode or RMS...';
    input.focus();
  }
}

/**
 * Hide product scan prompt
 */
function hideProductScanPrompt() {
  const promptEl = document.getElementById('productScanPrompt');
  if (promptEl) promptEl.classList.remove('active');
  
  const input = document.getElementById('inputBarcode');
  if (input) {
    input.placeholder = 'Scan or paste barcode...';
  }
}

/**
 * Clear pending item and reset scan mode
 */
function clearPendingItem() {
  App.pendingItem = null;
  App.scanMode = 'normal';
  hideProductScanPrompt();
}

/**
 * Cancel pending item
 */
function cancelPendingScan() {
  clearPendingItem();
  toast('Scan cancelled', 'info');
}

/**
 * Skip product lookup and save as unknown
 */
async function skipProductLookup() {
  if (!App.pendingItem) return;
  
  const parsed = App.pendingItem;
  clearPendingItem();
  
  await saveItem(parsed, { name: 'Unknown Product', rms: '', matchType: 'SKIPPED' });
}

/**
 * Show manual entry modal
 */
function showManualEntryModal(parsed, productCode) {
  document.getElementById('manualGtin').value = parsed?.gtin || '';
  document.getElementById('manualExpiry').value = parsed?.expiryISO || '';
  document.getElementById('manualBatch').value = parsed?.batch || '';
  document.getElementById('manualProductCode').value = productCode || '';
  document.getElementById('manualName').value = '';
  document.getElementById('manualRms').value = '';
  
  document.getElementById('manualEntryModal').classList.add('active');
  document.getElementById('manualName').focus();
}

/**
 * Save manual entry
 */
async function saveManualEntry() {
  const name = document.getElementById('manualName').value.trim();
  const rms = document.getElementById('manualRms').value.trim();
  const gtin = document.getElementById('manualGtin').value.trim();
  const expiryISO = document.getElementById('manualExpiry').value;
  const batch = document.getElementById('manualBatch').value.trim();
  const productCode = document.getElementById('manualProductCode').value.trim();
  
  if (!name) {
    toast('Please enter product name', 'warning');
    return;
  }
  
  // Create parsed object
  const parsed = {
    raw: gtin,
    gtin: GS1.normalizeGTIN(gtin),
    expiry: '',
    expiryISO: expiryISO,
    expiryDisplay: expiryISO ? formatDateDisplay(expiryISO) : '',
    batch: batch,
    serial: '',
    qty: 1
  };
  
  const product = { name, rms, matchType: 'MANUAL' };
  
  // Save to master for future lookups
  if (gtin) {
    await DB.addMaster({ barcode: parsed.gtin, name, rms });
  }
  if (productCode && productCode !== gtin) {
    await DB.addMaster({ barcode: productCode, name, rms });
  }
  
  await refreshMasterCount();
  
  // Close modal
  closeManualEntryModal();
  clearPendingItem();
  
  // Save item
  await saveItem(parsed, product);
}

function closeManualEntryModal() {
  document.getElementById('manualEntryModal').classList.remove('active');
}

function formatDateDisplay(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// ============================================
// BULK PROCESSING
// ============================================
async function processBulk() {
  const textarea = document.getElementById('inputBulk');
  const text = textarea.value.trim();
  
  if (!text) {
    toast('No barcodes to process', 'warning');
    return;
  }
  
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);
  
  if (lines.length === 0) {
    toast('No valid lines found', 'warning');
    return;
  }
  
  const progressBar = document.getElementById('bulkProgress');
  const progressFill = document.getElementById('bulkProgressFill');
  const progressText = document.getElementById('bulkProgressText');
  const btn = document.getElementById('btnProcessBulk');
  
  progressBar.classList.add('active');
  progressText.classList.add('active');
  btn.disabled = true;
  
  let success = 0;
  let failed = 0;
  
  for (let i = 0; i < lines.length; i++) {
    try {
      // In bulk mode, skip product scan prompt - save as unknown if not found
      const parsed = GS1.parse(lines[i]);
      if (parsed.gtin) {
        let product = Matcher.find(parsed.gtin);
        
        if (!product && App.settings.apiEnabled) {
          const apiResult = await API.lookup(parsed.gtin);
          if (apiResult) {
            product = { name: apiResult.name, rms: '', matchType: 'API' };
          }
        }
        
        if (!product) {
          product = { name: 'Unknown Product', rms: '', matchType: 'NONE' };
        }
        
        await saveItem(parsed, product, { silent: true, skipRefresh: true });
        success++;
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
    }
    
    const percent = Math.round(((i + 1) / lines.length) * 100);
    progressFill.style.width = percent + '%';
    progressText.textContent = `Processing ${i + 1} of ${lines.length}...`;
    
    if (i % 20 === 0) await sleep(10);
  }
  
  progressText.textContent = `Done! ${success} added, ${failed} failed`;
  btn.disabled = false;
  
  await refreshUI();
  
  textarea.value = '';
  updateBulkCount();
  
  toast(`Processed ${success} barcodes`, 'success');
  vibrate('success');
  
  setTimeout(() => {
    progressBar.classList.remove('active');
    progressText.classList.remove('active');
  }, 3000);
}

function updateBulkCount() {
  const textarea = document.getElementById('inputBulk');
  const countEl = document.getElementById('bulkCount');
  if (!textarea || !countEl) return;
  
  const lines = textarea.value.trim().split(/[\r\n]+/).filter(l => l.trim()).length;
  countEl.textContent = lines > 0 ? `${lines} line${lines !== 1 ? 's' : ''}` : '0 lines';
}

function toggleBulk() {
  const area = document.getElementById('bulkArea');
  const toggle = document.getElementById('bulkToggle');
  
  if (area.classList.contains('hidden')) {
    area.classList.remove('hidden');
    toggle.classList.remove('collapsed');
  } else {
    area.classList.add('hidden');
    toggle.classList.add('collapsed');
  }
}

// ============================================
// CAMERA SCANNER
// ============================================
const Scanner = {
  async init() {
    try {
      App.scanner.cameras = await Html5Qrcode.getCameras();
      if (App.scanner.cameras.length === 0) {
        toast('No camera found', 'error');
        return false;
      }
      
      const backIdx = App.scanner.cameras.findIndex(c =>
        c.label.toLowerCase().includes('back') ||
        c.label.toLowerCase().includes('rear') ||
        c.label.toLowerCase().includes('environment')
      );
      App.scanner.currentCamera = backIdx >= 0 ? backIdx : 0;
      
      return true;
    } catch (e) {
      toast('Camera access denied', 'error');
      return false;
    }
  },

  async toggle() {
    if (App.scanner.active) {
      await this.stop();
    } else {
      await this.start();
    }
  },

  async start() {
    if (App.scanner.cameras.length === 0) {
      const ok = await this.init();
      if (!ok) return;
    }
    
    try {
      App.scanner.instance = new Html5Qrcode('reader');
      
      const config = {
        fps: 10,
        qrbox: { width: 250, height: 150 },
        formatsToSupport: [
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.ITF
        ]
      };
      
      await App.scanner.instance.start(
        App.scanner.cameras[App.scanner.currentCamera].id,
        config,
        this.onScan.bind(this),
        () => {}
      );
      
      App.scanner.active = true;
      document.getElementById('scannerBox').classList.add('active');
      document.getElementById('btnScanner').innerHTML = '<span>⏹️</span> Stop Scanner';
      document.getElementById('btnScanner').classList.add('active');
      
      vibrate('medium');
    } catch (e) {
      console.error('Scanner error:', e);
      toast('Scanner error', 'error');
    }
  },

  async stop() {
    if (!App.scanner.instance) return;
    
    try {
      await App.scanner.instance.stop();
      App.scanner.instance.clear();
    } catch (e) {}
    
    App.scanner.active = false;
    App.scanner.instance = null;
    
    document.getElementById('scannerBox').classList.remove('active');
    document.getElementById('btnScanner').innerHTML = '<span>📷</span> Open Camera';
    document.getElementById('btnScanner').classList.remove('active');
  },

  async onScan(decodedText) {
    console.log('📷 Scanned:', decodedText);
    
    await this.stop();
    
    document.getElementById('inputBarcode').value = decodedText;
    
    // Check if we're in product scan mode
    if (App.scanMode === 'product' && App.pendingItem) {
      await processBarcode(decodedText, { isProductScan: true });
    } else {
      await processBarcode(decodedText);
    }
  }
};

// ============================================
// UI REFRESH
// ============================================
async function refreshUI() {
  await Promise.all([
    refreshStats(),
    refreshRecent(),
    refreshHistory(),
    refreshMasterCount()
  ]);
}

async function refreshStats() {
  const history = await DB.getAllHistory();
  
  let expired = 0, expiring = 0, ok = 0;
  
  for (const item of history) {
    const status = GS1.getExpiryStatus(item.expiryISO);
    if (status === 'expired') expired++;
    else if (status === 'expiring') expiring++;
    else if (status === 'ok') ok++;
  }
  
  document.getElementById('statExpired').textContent = expired;
  document.getElementById('statExpiring').textContent = expiring;
  document.getElementById('statOk').textContent = ok;
}

async function refreshRecent() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);
  
  const recent = history.slice(0, 10);
  const container = document.getElementById('recentList');
  
  if (recent.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <div class="empty-title">No items yet</div>
        <div class="empty-text">Scan or paste a barcode to start</div>
      </div>
    `;
    return;
  }
  
  container.innerHTML = recent.map(item => renderItemCard(item)).join('');
}

async function refreshHistory() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);
  
  let filtered = history;
  
  if (App.filter !== 'all') {
    filtered = history.filter(h => GS1.getExpiryStatus(h.expiryISO) === App.filter);
  }
  
  if (App.search) {
    const q = App.search.toLowerCase();
    filtered = filtered.filter(h =>
      (h.name && h.name.toLowerCase().includes(q)) ||
      (h.gtin && h.gtin.includes(q)) ||
      (h.batch && h.batch.toLowerCase().includes(q)) ||
      (h.rms && h.rms.includes(q))
    );
  }
  
  const container = document.getElementById('historyList');
  
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No items found</div>
        <div class="empty-text">Try a different filter or search</div>
      </div>
    `;
    return;
  }
  
  container.innerHTML = filtered.map(item => renderItemCard(item, true)).join('');
}

function renderItemCard(item, showActions = true) {
  const status = GS1.getExpiryStatus(item.expiryISO);
  const days = GS1.getDaysUntil(item.expiryISO);
  const cardClass = item.matchType === 'API' ? 'api' : status;
  
  let daysText = '';
  if (status === 'expired') {
    daysText = `${Math.abs(days)}d ago`;
  } else if (days !== Infinity) {
    daysText = `${days}d left`;
  }
  
  return `
    <div class="item-card ${cardClass}" data-id="${item.id}">
      <div class="item-header">
        <span class="item-name">${escapeHtml(item.name || 'Unknown')}</span>
        <span class="item-badge">${item.expiryDisplay || 'No expiry'}</span>
      </div>
      <div class="item-details">
        <div class="item-detail">
          <span class="item-detail-label">GTIN:</span>
          <span class="item-detail-value">${item.gtin || '-'}</span>
        </div>
        <div class="item-detail">
          <span class="item-detail-label">Batch:</span>
          <span class="item-detail-value">${item.batch || '-'}</span>
        </div>
        <div class="item-detail">
          <span class="item-detail-label">RMS:</span>
          <span class="item-detail-value">${item.rms || '-'}</span>
        </div>
        ${daysText ? `
        <div class="item-detail">
          <span class="item-detail-label">Status:</span>
          <span class="item-detail-value status-${status}">${daysText}</span>
        </div>
        ` : ''}
      </div>
      ${showActions ? `
        <div class="item-actions">
          <button class="item-btn edit" onclick="editItem(${item.id})">✏️ Edit</button>
          <button class="item-btn delete" onclick="deleteItem(${item.id})">🗑️ Delete</button>
        </div>
      ` : ''}
    </div>
  `;
}

async function refreshMasterCount() {
  const master = await DB.getAllMaster();
  const countEl = document.getElementById('masterCount');
  if (countEl) countEl.textContent = master.length;
  
  Matcher.buildIndex(master);
}

// ============================================
// EDIT & DELETE
// ============================================
async function editItem(id) {
  const item = await DB.getHistory(id);
  if (!item) {
    toast('Item not found', 'error');
    return;
  }
  
  document.getElementById('editId').value = id;
  document.getElementById('editName').value = item.name || '';
  document.getElementById('editGtin').value = item.gtin || '';
  document.getElementById('editExpiry').value = item.expiryISO || '';
  document.getElementById('editBatch').value = item.batch || '';
  document.getElementById('editQty').value = item.qty || 1;
  document.getElementById('editRms').value = item.rms || '';
  document.getElementById('editSupplier').value = item.supplier || '';
  document.getElementById('editReturnable').value = item.returnable || '';
  
  document.getElementById('editModal').classList.add('active');
}

async function saveEdit() {
  const id = parseInt(document.getElementById('editId').value);
  const item = await DB.getHistory(id);
  if (!item) {
    toast('Item not found', 'error');
    return;
  }
  
  const expiryISO = document.getElementById('editExpiry').value;
  
  item.name = document.getElementById('editName').value.trim();
  item.expiryISO = expiryISO;
  item.expiryDisplay = expiryISO ? formatDateDisplay(expiryISO) : '';
  item.batch = document.getElementById('editBatch').value.trim();
  item.qty = parseInt(document.getElementById('editQty').value) || 1;
  item.rms = document.getElementById('editRms').value.trim();
  item.supplier = document.getElementById('editSupplier').value.trim();
  item.returnable = document.getElementById('editReturnable').value;
  
  await DB.updateHistory(item);
  
  // Update master if name provided
  if (item.name && item.gtin) {
    await DB.addMaster({
      barcode: item.gtin,
      name: item.name,
      rms: item.rms
    });
    await refreshMasterCount();
  }
  
  closeModal();
  await refreshUI();
  toast('Item updated', 'success');
}

function closeModal() {
  document.getElementById('editModal').classList.remove('active');
}

async function deleteItem(id) {
  if (!confirm('Delete this item?')) return;
  
  await DB.deleteHistory(id);
  await refreshUI();
  toast('Item deleted', 'success');
}

// ============================================
// MASTER DATA MANAGEMENT
// ============================================
async function uploadMaster(file, append = false) {
  showLoading('Uploading...');
  
  try {
    const text = await file.text();
    const lines = text.trim().split(/[\r\n]+/);
    
    if (lines.length < 2) {
      toast('Invalid file format', 'error');
      hideLoading();
      return;
    }
    
    const header = lines[0].toLowerCase();
    const delim = header.includes('\t') ? '\t' : ',';
    const cols = header.split(delim).map(c => c.trim().replace(/['"]/g, ''));
    
    const barcodeIdx = cols.findIndex(c => ['barcode', 'gtin', 'ean', 'upc', 'code'].includes(c));
    const nameIdx = cols.findIndex(c => ['name', 'description', 'product', 'productname'].includes(c));
    const rmsIdx = cols.findIndex(c => ['rms', 'rmscode', 'rms code', 'rms_id', 'rms id'].includes(c));
    
    if (barcodeIdx === -1) {
      toast('No barcode column found', 'error');
      hideLoading();
      return;
    }
    
    if (!append) {
      await DB.clearMaster();
    }
    
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i], delim);
      const barcode = (row[barcodeIdx] || '').replace(/\D/g, '');
      const name = nameIdx >= 0 ? row[nameIdx] : '';
      const rms = rmsIdx >= 0 ? row[rmsIdx] : '';
      
      if (barcode && barcode.length >= 8) {
        items.push({ barcode, name, rms });
      }
    }
    
    const count = await DB.bulkAddMaster(items);
    await refreshMasterCount();
    
    toast(`${append ? 'Appended' : 'Uploaded'} ${count} products`, 'success');
  } catch (e) {
    console.error('Upload error:', e);
    toast('Upload failed: ' + e.message, 'error');
  }
  
  hideLoading();
}

function parseCSVLine(line, delim = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delim && !inQuotes) {
      result.push(current.trim().replace(/^["']|["']$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim().replace(/^["']|["']$/g, ''));
  
  return result;
}

async function resetMaster() {
  if (!confirm('Reset all product data? This cannot be undone.')) return;
  
  await DB.clearMaster();
  await refreshMasterCount();
  toast('Master data cleared', 'success');
}

function downloadTemplate() {
  const template = `barcode,name,rms
8410520015021,Voltaren 12 Hour Emulgel 2.32% 100g,
6291109120636,Panadol Advance 24s,220236078
06291107439358,Zyrtec 75ml Bottle,220155756
00840149658430,VIAGRA 100MG 4S,220153086
06285074002448,Yasmin 21s Blister,220164755`;

  downloadFile(template, 'master-template.csv', 'text/csv');
  toast('Template downloaded', 'success');
}

// ============================================
// EXPORT & BACKUP
// ============================================
async function exportCSV() {
  const history = await DB.getAllHistory();
  
  if (history.length === 0) {
    toast('No data to export', 'warning');
    return;
  }
  
  const headers = ['RMS', 'BARCODE', 'DESCRIPTION', 'EXPIRY', 'BATCH', 'QTY', 'RETURNABLE', 'SUPPLIER', 'STATUS'];
  const rows = history.map(h => [
    h.rms || '',
    h.gtin || '',
    h.name || '',
    h.expiryDisplay || '',
    h.batch || '',
    h.qty || 1,
    h.returnable || '',
    h.supplier || '',
    GS1.getExpiryStatus(h.expiryISO)
  ]);
  
  let csv = headers.join(',') + '\n';
  for (const row of rows) {
    csv += row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n';
  }
  
  downloadFile(csv, `expiry-export-${formatDateFile(new Date())}.csv`, 'text/csv');
  toast('Export downloaded', 'success');
}

async function downloadBackup() {
  const data = await DB.exportAll();
  data.date = new Date().toISOString();
  
  downloadFile(JSON.stringify(data, null, 2), `backup-${formatDateFile(new Date())}.json`, 'application/json');
  toast('Backup downloaded', 'success');
}

async function restoreBackup(file) {
  showLoading('Restoring...');
  
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    
    if (!backup.history && !backup.master) {
      toast('Invalid backup file', 'error');
      hideLoading();
      return;
    }
    
    await DB.importAll(backup);
    await refreshUI();
    await refreshMasterCount();
    
    toast(`Restored ${backup.history?.length || 0} items, ${backup.master?.length || 0} products`, 'success');
  } catch (e) {
    console.error('Restore error:', e);
    toast('Restore failed', 'error');
  }
  
  hideLoading();
}

async function clearHistory() {
  if (!confirm('Clear all scanned items? This cannot be undone.')) return;
  
  await DB.clearHistory();
  await refreshUI();
  toast('History cleared', 'success');
}

// ============================================
// NAVIGATION
// ============================================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  
  const page = document.getElementById(`page-${pageId}`);
  if (page) page.classList.add('active');
  
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-btn[data-page="${pageId}"]`)?.classList.add('active');
  
  if (pageId !== 'home' && App.scanner.active) {
    Scanner.stop();
  }
  
  closeMenu();
  vibrate('light');
}

function openMenu() {
  document.getElementById('menuOverlay').classList.add('active');
  document.getElementById('sideMenu').classList.add('active');
}

function closeMenu() {
  document.getElementById('menuOverlay').classList.remove('active');
  document.getElementById('sideMenu').classList.remove('active');
}

function filterBy(status) {
  App.filter = status;
  
  document.querySelectorAll('.filter-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.filter === status);
  });
  
  refreshHistory();
  showPage('history');
}

// ============================================
// UTILITIES
// ============================================
function toast(message, type = 'info') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function showLoading(text = 'Loading...') {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loading').classList.add('active');
}

function hideLoading() {
  document.getElementById('loading').classList.remove('active');
}

function vibrate(type = 'light') {
  if (!navigator.vibrate) return;
  
  switch (type) {
    case 'light': navigator.vibrate(10); break;
    case 'medium': navigator.vibrate(30); break;
    case 'success': navigator.vibrate([30, 50, 30]); break;
    case 'error': navigator.vibrate([100, 50, 100]); break;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateFile(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================
// EVENT SETUP
// ============================================
function setupEvents() {
  // Single barcode input
  const inputBarcode = document.getElementById('inputBarcode');
  
  inputBarcode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = inputBarcode.value.trim();
      
      if (App.scanMode === 'product' && App.pendingItem) {
        processBarcode(code, { isProductScan: true });
      } else {
        processBarcode(code);
      }
      inputBarcode.value = '';
    }
  });
  
  inputBarcode.addEventListener('paste', () => {
    setTimeout(() => {
      const code = inputBarcode.value.trim();
      
      if (App.scanMode === 'product' && App.pendingItem) {
        processBarcode(code, { isProductScan: true });
      } else {
        processBarcode(code);
      }
      inputBarcode.value = '';
    }, 100);
  });
  
  // Bulk input
  document.getElementById('inputBulk').addEventListener('input', updateBulkCount);
  document.getElementById('inputBulk').addEventListener('paste', () => setTimeout(updateBulkCount, 100));
  document.getElementById('btnProcessBulk').addEventListener('click', processBulk);
  
  // Scanner
  document.getElementById('btnScanner').addEventListener('click', () => Scanner.toggle());
  
  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });
  
  // Menu
  document.getElementById('btnMenu').addEventListener('click', openMenu);
  document.getElementById('menuOverlay').addEventListener('click', closeMenu);
  
  // Search
  document.getElementById('inputSearch').addEventListener('input', (e) => {
    App.search = e.target.value;
    refreshHistory();
  });
  
  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      App.filter = tab.dataset.filter;
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      refreshHistory();
    });
  });
  
  // File inputs
  document.getElementById('fileMaster').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      uploadMaster(e.target.files[0], false);
      e.target.value = '';
    }
  });
  
  document.getElementById('fileAppend').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      uploadMaster(e.target.files[0], true);
      e.target.value = '';
    }
  });
  
  document.getElementById('fileRestore').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      restoreBackup(e.target.files[0]);
      e.target.value = '';
    }
  });
  
  // API toggle
  const apiToggle = document.getElementById('toggleAPI');
  apiToggle.addEventListener('change', () => {
    App.settings.apiEnabled = apiToggle.checked;
    updateAPIIndicator();
    DB.setSetting('apiEnabled', apiToggle.checked);
  });
  
  document.getElementById('btnToggleAPI').addEventListener('click', () => {
    apiToggle.checked = !apiToggle.checked;
    App.settings.apiEnabled = apiToggle.checked;
    updateAPIIndicator();
    DB.setSetting('apiEnabled', apiToggle.checked);
  });
  
  // Edit modal
  document.getElementById('editModal').addEventListener('click', (e) => {
    if (e.target.id === 'editModal') closeModal();
  });
  
  // Manual entry modal
  document.getElementById('manualEntryModal').addEventListener('click', (e) => {
    if (e.target.id === 'manualEntryModal') closeManualEntryModal();
  });
  
  // Product scan prompt buttons
  document.getElementById('btnCancelScan')?.addEventListener('click', cancelPendingScan);
  document.getElementById('btnSkipLookup')?.addEventListener('click', skipProductLookup);
  document.getElementById('btnManualEntry')?.addEventListener('click', () => {
    hideProductScanPrompt();
    showManualEntryModal(App.pendingItem, '');
  });
  
  // Manual entry save
  document.getElementById('btnSaveManual')?.addEventListener('click', saveManualEntry);
  document.getElementById('btnCancelManual')?.addEventListener('click', closeManualEntryModal);
}

function updateAPIIndicator() {
  const indicator = document.querySelector('.api-indicator');
  if (App.settings.apiEnabled) {
    indicator.classList.remove('off');
    indicator.classList.add('on');
  } else {
    indicator.classList.remove('on');
    indicator.classList.add('off');
  }
}

// ============================================
// INITIALIZATION
// ============================================
async function init() {
  console.log('🚀 Expiry Tracker v' + CONFIG.VERSION + ' starting...');
  
  try {
    await DB.init();
    
    App.settings.apiEnabled = await DB.getSetting('apiEnabled', true);
    document.getElementById('toggleAPI').checked = App.settings.apiEnabled;
    updateAPIIndicator();
    
    await refreshMasterCount();
    await refreshUI();
    
    setupEvents();
    
    setTimeout(() => {
      document.getElementById('splash').classList.add('hidden');
      document.getElementById('app').classList.add('visible');
      
      setTimeout(() => {
        document.getElementById('inputBarcode').focus();
      }, 100);
    }, 2000);
    
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(() => console.log('✅ Service Worker registered'))
        .catch(e => console.log('SW registration failed:', e));
    }
    
    console.log('✅ App ready!');
  } catch (e) {
    console.error('Init error:', e);
    toast('Failed to initialize app', 'error');
    
    document.getElementById('splash').classList.add('hidden');
    document.getElementById('app').classList.add('visible');
  }
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
