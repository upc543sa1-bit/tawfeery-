const API_BASE = (window.TAWFEERY_API || '').replace(/\/$/, '') || ''; // set to https://tawfeery-o3dn.onrender.com for HF Static split
const api = (path) => `${API_BASE}${path}`;
document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const searchForm           = document.getElementById('search-form');
    const searchInput          = document.getElementById('search-input');
    const loadingState         = document.getElementById('loading-state');
    const loadingText          = document.getElementById('loading-text');
    const errorState           = document.getElementById('error-state');
    const resultsContainer     = document.getElementById('results-container');
    const resultsGrid          = document.getElementById('results-grid');
    const resultsCount         = document.getElementById('results-count');
    const cardTemplate         = document.getElementById('result-card-template');
    const skeletonTemplate     = document.getElementById('skeleton-card-template');

    // History and Basket DOM elements
    const historyContainer     = document.getElementById('search-history-container');
    const historyItemsWrapper  = document.getElementById('search-history-items');
    const clearHistoryBtn      = document.getElementById('clear-history-btn');

    const basketToggle         = document.getElementById('basket-toggle');
    const basketDrawer         = document.getElementById('basket-drawer');
    const basketCloseBtn       = document.getElementById('basket-close-btn');
    const basketCount          = document.getElementById('basket-count');
    const basketItemsList      = document.getElementById('basket-items-list');
    const basketDashboard      = document.getElementById('basket-comparison-dashboard');
    const clearBasketBtn       = document.getElementById('clear-basket-btn');
    
    const basketTotalNahdi     = document.getElementById('basket-total-nahdi');
    const basketTotalDawaa     = document.getElementById('basket-total-dawaa');
    const basketTotalUnited    = document.getElementById('basket-total-united');
    const basketTotalMoaz      = document.getElementById('basket-total-moaz');
    const basketTotalPharma    = document.getElementById('basket-total-pharmabrand');
    const basketWinnerBanner   = document.getElementById('basket-winner-banner');

    // Product Modal DOM elements
    const productModal         = document.getElementById('product-modal');
    const modalCloseBtn        = document.getElementById('modal-close-btn');
    const modalProductImg      = document.getElementById('modal-product-img');
    const modalStoreBadge      = document.getElementById('modal-store-badge');
    const modalOfferBadge      = document.getElementById('modal-offer-badge');
    const modalProductTitle    = document.getElementById('modal-product-title');
    const modalPriceValue      = document.getElementById('modal-price-value');
    const modalEquivalentsList = document.getElementById('modal-equivalents-list');

    // Checkout Modal DOM elements
    const checkoutModal        = document.getElementById('checkout-modal');
    const checkoutCloseBtn     = document.getElementById('checkout-modal-close-btn');
    const checkoutStoreName    = document.getElementById('checkout-store-name');
    const checkoutItemsList    = document.getElementById('checkout-items-list');
    const checkoutOpenAllBtn   = document.getElementById('checkout-open-all-btn');

    // State Variables
    let allResults    = []; // Accumulate search results
    let basket        = JSON.parse(localStorage.getItem('tawfeery_basket')) || [];
    let favorites     = JSON.parse(localStorage.getItem('tawfeery_favorites')) || [];
    let searchHistory = JSON.parse(localStorage.getItem('tawfeery_history')) || [];
    let sessionScrapedProducts = JSON.parse(localStorage.getItem('tawfeery_scraped_cache')) || [];
    let customEquivalents = JSON.parse(localStorage.getItem('tawfeery_custom_equivalents')) || {};
    let currentQuery  = '';

    // Variant keywords that distinguish product forms (soap vs gel etc.)
    var VARIANT_KEYWORDS = [
        'صابونه','صابون','جل','غسول','مقشر','كريم','سيروم','شامبو','بلسم','تونر','ماسك','مرطب','واقي','زيت','سبراي','بخاخ','لوشن','غسول','منظف','مقشر','gommant','gel','soap','bar','pain','cleanser','cream','serum','shampoo','conditioner','toner','mask','lotion','oil','spray','exfoliant','purifying','sebium','h2o','sensitive'
    ];
    function getVariantTokens(name) {
        const cleaned = cleanName(name);
        const tokens = cleaned.split(' ');
        const variants = new Set();
        for (const t of tokens) {
            const norm = t.replace('ـ','');
            for (const v of VARIANT_KEYWORDS) {
                if (norm === v || norm.includes(v) || v.includes(norm)) {
                    if (['صابونه','صابون','جل','غسول','مقشر','كريم','gommant','gel','soap','bar','pain'].includes(v) || norm.length>3) {
                        variants.add(v);
                    }
                }
            }
            if (['صابونه','صابون','جل','غسول','مقشر'].includes(norm)) variants.add(norm);
            if (['gel','soap','bar','cleanser','gommant'].includes(norm)) variants.add(norm);
        }
        return variants;
    }
    function hasVariantMismatch(aVariants, bVariants) {
        if (aVariants.size===0 || bVariants.size===0) return false;
        for (const v of aVariants) if (bVariants.has(v)) return false;
        const soapSet = new Set(['صابونه','صابون','soap','bar','pain']);
        const gelSet = new Set(['جل','غسول','مقشر','gel','gommant','cleanser']);
        const hasSoapA = [...aVariants].some(v=> soapSet.has(v));
        const hasSoapB = [...bVariants].some(v=> soapSet.has(v));
        const hasGelA = [...aVariants].some(v=> gelSet.has(v));
        const hasGelB = [...bVariants].some(v=> gelSet.has(v));
        if ((hasSoapA && hasGelB) || (hasGelA && hasSoapB)) return true;
        return false;
    }

    // Deals Section DOM
    const dealsSection  = document.getElementById('deals-section');
    const dealsGrid     = document.getElementById('deals-grid');
    const dealsLoading  = document.getElementById('deals-loading');
    const dealsCountBadge = document.getElementById('deals-count-badge');
    const cheapestWidget = document.getElementById('cheapest-pharmacy');
    let dealsData       = [];
    let dealsShowCount  = 48;
    let activeStoreFilter = 'all';

    // Store filter click handler
    const storeFiltersEl = document.getElementById('store-filters');
    if (storeFiltersEl) {
        storeFiltersEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.store-filter-btn');
            if (!btn) return;
            document.querySelectorAll('.store-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeStoreFilter = btn.dataset.store;
            renderDealsChunk();
        });
    }

    function renderStoreStats() {
        if (!dealsData || dealsData.length === 0) return;
        const stores = {};
        dealsData.forEach(item => {
            const s = item.store;
            if (!stores[s]) stores[s] = { count: 0, total: 0 };
            stores[s].count++;
            stores[s].total += getEffectiveUnitPriceForSorting(parseFloat(item.price), item.offer);
        });
        // Update counts
        document.getElementById('sf-count-all').textContent = dealsData.length;
        const map = { 'United Pharmacy': 'united', 'Nahdi Online': 'nahdi', 'Al-Dawaa': 'dawaa', 'Moaz Pharma': 'moaz', 'PharmaBrand': 'pharmabrand' };
        for (const [key, id] of Object.entries(map)) {
            const el = document.getElementById('sf-count-' + id);
            if (el) el.textContent = stores[key] ? stores[key].count : 0;
        }
        // Find cheapest average
        let cheapest = null, cheapestAvg = Infinity;
        for (const [name, data] of Object.entries(stores)) {
            const avg = data.total / data.count;
            if (avg < cheapestAvg) { cheapestAvg = avg; cheapest = name; }
        }
        if (cheapest && cheapestWidget) {
            const storeNames = { 'United Pharmacy': 'المتحدة', 'Nahdi Online': 'النهدي', 'Al-Dawaa': 'الدواء', 'Moaz Pharma': 'معاذ', 'PharmaBrand': 'فارما براند' };
            const avgFormatted = cheapestAvg.toFixed(2);
            cheapestWidget.innerHTML = `
                <span class="cp-icon">🏅</span>
                <span class="cp-label">أوفر صيدلية:</span>
                <span class="cp-store">${storeNames[cheapest] || cheapest}</span>
                <span class="cp-label">بمتوسط</span>
                <span class="cp-avg">${avgFormatted} SAR</span>
                <span class="cp-savings">يوفّر لك أكثر من الباقي</span>
            `;
            cheapestWidget.classList.remove('hidden');
        }
    }

    // Initialize UI
    renderHistory();
    updateBasketUI();
    fetchDeals();

    // Magic tabs click handler
    const magicTabsEl = document.getElementById('magic-tabs');
    if (magicTabsEl) {
        magicTabsEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.magic-tab');
            if (!btn) return;
            const filter = btn.dataset.filter;
            applyMagicFilter(filter);
        });
    }

    // ── BEST DEALS LOGIC ─────────────────────────────────────────────────────

    async function fetchDeals(retries = 60) {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 25000);
                const res = await fetch(api('/api/deals'), { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!res.ok) { dealsLoading.textContent = ''; return; }
                dealsData = await res.json();
                if (!dealsData || dealsData.length === 0) {
                    if (attempt < retries - 1) {
                        const dots = '.'.repeat((attempt % 3) + 1);
                        dealsLoading.textContent = `جاري البحث عن أفضل العروض${dots}`;
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                    dealsLoading.textContent = '';
                    return;
                }
                dealsLoading.style.display = 'none';
                renderStoreStats();
                renderDealsChunk();
                return;
            } catch (e) {
                if (attempt < retries - 1) {
                    dealsLoading.textContent = `جاري تحميل أفضل العروض... (محاولة ${attempt + 2})`;
                    await new Promise(r => setTimeout(r, 3000));
                } else {
                    dealsLoading.textContent = '';
                }
            }
        }
    }

    function renderDealsChunk() {
        const filtered = activeStoreFilter === 'all'
            ? dealsData
            : dealsData.filter(d => d.store === activeStoreFilter);
        const toShow = filtered.slice(0, dealsShowCount);
        dealsGrid.innerHTML = '';
        toShow.forEach((item, idx) => {
            const card = buildDealCard(item, idx);
            dealsGrid.appendChild(card);
        });
        if (dealsCountBadge) dealsCountBadge.textContent = `${filtered.length}+ منتج`;

        // Remove old load-more if exists
        const oldBtn = document.querySelector('.deals-load-more');
        if (oldBtn) oldBtn.remove();

        if (dealsShowCount < filtered.length) {
            const btn = document.createElement('button');
            btn.className = 'deals-load-more';
            btn.textContent = `عرض المزيد (${filtered.length - dealsShowCount}+)`;
            btn.addEventListener('click', () => {
                dealsShowCount += 48;
                renderDealsChunk();
            });
            dealsGrid.after(btn);
        }
    }

    function buildDealCard(item, idx) {
        const div = document.createElement('div');
        div.className = 'deal-card';
        div.style.animationDelay = `${idx * 0.06}s`;

        const hasOffer = !!item.offer;
        if (hasOffer) div.classList.add('has-offer');

        const img = item.image
            ? `<img src="${item.image}" alt="${item.name}" class="deal-img" onerror="this.style.display='none';this.parentElement.style.background='var(--bg-secondary)'">`
            : '<div class="deal-img-placeholder">💊</div>';

        const badgeClass = item.store.includes('Nahdi') ? 'store-nahdi'
            : item.store.includes('Dawaa') ? 'store-dawaa'
            : item.store.includes('United') ? 'store-united'
            : item.store.includes('Moaz') ? 'store-moaz'
            : item.store.includes('PharmaBrand') ? 'store-pharmabrand'
            : 'store-united';

        const offerHtml = item.offer
            ? `<div class="deal-offer-tag">🎁 ${item.offer}</div>`
            : '';

        const badgeLabel = hasOffer ? '🔥 عرض' : '💊 منتج';

        // Price processing — apply promo to effective price
        const regularPrice = parseFloat(item.price);
        const promoInfo = getPromoInfo(regularPrice, item.offer);
        let displayPrice = regularPrice;
        let strikePrice = null;

        if (promoInfo) {
            if (promoInfo.type === 'info') {
                displayPrice = promoInfo.unitPrice;
                strikePrice = promoInfo.originalPrice;
            } else if (promoInfo.type === 'discount') {
                displayPrice = promoInfo.unitPrice;
                strikePrice = regularPrice;
            } else if (promoInfo.type === 'bundle') {
                displayPrice = promoInfo.unitPrice;
                strikePrice = regularPrice;
            } else if (promoInfo.type === 'delivery') {
                displayPrice = promoInfo.deliveryPrice;
                strikePrice = regularPrice;
            }
        }

        const strikeHtml = strikePrice && strikePrice > displayPrice
            ? `<span class="deal-price-strike">${strikePrice.toFixed(2)}</span>`
            : '';

        // Unit price display (based on effective price)
        let unitPriceHtml = '';
        if (item.quantity && item.quantity > 0) {
            const unitP = displayPrice / item.quantity;
            unitPriceHtml = `<div class="deal-unit-price">${unitP.toFixed(3)} SAR / الحبة</div>`;
        }

        // Promo label for deal cards
        let promoLabel = '';
        if (promoInfo && promoInfo.type === 'info' && strikePrice) {
            const saving = strikePrice - displayPrice;
            promoLabel = `<div class="deal-promo-label">وفّر ${saving.toFixed(2)} SAR</div>`;
        } else if (promoInfo && promoInfo.type === 'discount' && strikePrice) {
            const saving = regularPrice - displayPrice;
            promoLabel = `<div class="deal-promo-label">وفّر ${saving.toFixed(2)} SAR</div>`;
        } else if (promoInfo && promoInfo.type === 'bundle' && strikePrice) {
            promoLabel = `<div class="deal-promo-label">سعر الحبة بالعرض</div>`;
        } else if (promoInfo && promoInfo.type === 'delivery' && strikePrice) {
            promoLabel = `<div class="deal-promo-label">سعر التوصيل</div>`;
        }

        const inBasket = basket.some(b => b.link === item.link);
        div.innerHTML = `
            <div class="deal-img-wrap">${img}</div>
            <div class="deal-body">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div class="deal-store-badge ${badgeClass}">${item.store}</div>
                    <span class="deal-type-badge ${hasOffer ? 'deal-type-offer' : 'deal-type-regular'}">${badgeLabel}</span>
                </div>
                <div class="deal-name">${item.name}</div>
                ${offerHtml}
                <div class="deal-price-row">
                    <div>
                        <span class="deal-price">${displayPrice.toFixed(2)} <span class="deal-currency">SAR</span></span>
                        ${strikeHtml}
                        ${promoLabel}
                        ${unitPriceHtml}
                    </div>
                    <div style="display:flex;gap:0.4rem;align-items:center;">
                        <button class="deal-basket-btn ${inBasket ? 'in-basket' : ''}" title="${inBasket ? 'في السلة' : 'أضف للسلة'}">${inBasket ? '✓' : '🛒'}</button>
                        <a href="${item.link}" target="_blank" rel="noopener noreferrer" class="deal-buy-btn">عرض</a>
                    </div>
                </div>
            </div>
        `;
        const bskBtn = div.querySelector('.deal-basket-btn');
        if (bskBtn) {
            bskBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleBasket(item, bskBtn);
                const nowIn = basket.some(b => b.link === item.link);
                bskBtn.textContent = nowIn ? '✓' : '🛒';
                bskBtn.classList.toggle('in-basket', nowIn);
                bskBtn.title = nowIn ? 'في السلة' : 'أضف للسلة';
            });
        }
        div.addEventListener('click', () => openModal(item));
        return div;
    }

    // ── SEARCH LOGIC ─────────────────────────────────────────────────────────

    searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = searchInput.value.trim();
        if (query) performSearch(query);
    });

    // Quick Search Pills Click
    document.querySelectorAll('.quick-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const query = pill.getAttribute('data-query');
            searchInput.value = query;
            performSearch(query);
        });
    });

    // Clear History Click
    clearHistoryBtn.addEventListener('click', () => {
        searchHistory = [];
        localStorage.setItem('tawfeery_history', JSON.stringify(searchHistory));
        renderHistory();
    });

    async function performSearch(query) {
        currentQuery = query;
        // Save to History
        if (!searchHistory.includes(query)) {
            searchHistory.unshift(query);
            if (searchHistory.length > 5) searchHistory.pop(); // Max 5 items
            localStorage.setItem('tawfeery_history', JSON.stringify(searchHistory));
            renderHistory();
        }

        // Reset UI State
        allResults = [];
        currentMagicFilter = 'all';
        magicBestLinks.clear();
        const magicEl = document.getElementById('magic-analysis');
        if (magicEl) magicEl.classList.add('hidden');
        resultsGrid.innerHTML = '';
        resultsCount.textContent = '0';
        errorState.classList.add('hidden');
        dealsSection.style.display = 'none';
        resultsContainer.classList.remove('hidden');
        loadingState.classList.remove('hidden');
        if (loadingText) loadingText.textContent = 'جاري البحث في الصيدليات...';

        // Render Skeletons initially
        for (let i = 0; i < 6; i++) {
            const skeleton = skeletonTemplate.content.cloneNode(true);
            resultsGrid.appendChild(skeleton);
        }

        try {
            const response = await fetch(api(`/api/search?q=${encodeURIComponent(query)}`));
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            let hasReceivedResults = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n\n');
                buffer = lines.pop(); // Keep incomplete last chunk

                for (const line of lines) {
                    const data = line.replace(/^data: /, '').trim();
                    if (!data) continue;

                    if (data === 'DONE') {
                        loadingState.classList.add('hidden');
                        
                        // Clear remaining skeletons if any
                        const skeletons = resultsGrid.querySelectorAll('.skeleton-card');
                        skeletons.forEach(s => s.remove());

                        // Cache search results in session cache
                        allResults.forEach(item => {
                            if (!sessionScrapedProducts.some(p => p.link === item.link)) {
                                sessionScrapedProducts.push(item);
                            }
                        });
                        localStorage.setItem('tawfeery_scraped_cache', JSON.stringify(sessionScrapedProducts));

                        if (allResults.length === 0) {
                            resultsContainer.classList.add('hidden');
                            dealsSection.style.display = '';
                            errorState.innerHTML = '<div class="error-icon">🔍</div><p>لم يتم العثور على نتائج. جرب كلمة بحث أخرى.</p>';
                            errorState.classList.remove('hidden');
                        } else {
                            resortGrid();
                        }
                        updateBasketUI();
                        return;
                    }

                    const parsed = JSON.parse(data);
                    const newItems = parsed.results || [];
                    
                    if (loadingText) {
                        loadingText.textContent = `وصلت نتائج ${parsed.store} — جاري انتظار الصيدليات المتبقية...`;
                    }

                    if (newItems.length === 0) continue;

                    // Remove skeletons on first real data
                    if (!hasReceivedResults) {
                        resultsGrid.innerHTML = '';
                        hasReceivedResults = true;
                    }

                    // Store new items
                    allResults.push(...newItems);

                    // Add items to UI
                    newItems.forEach((item) => {
                        const card = buildCard(item);
                        resultsGrid.appendChild(card);
                    });

                    resultsCount.textContent = allResults.length;
                }
            }
        } catch (error) {
            console.error('Search error:', error);
            loadingState.classList.add('hidden');
            resultsGrid.innerHTML = '';
            resultsContainer.classList.add('hidden');
            dealsSection.style.display = '';
            errorState.innerHTML = `
                <div class="error-icon">⚠️</div>
                <p>عذراً، حدث خطأ أثناء الاتصال. يرجى المحاولة مرة أخرى.</p>
                <button onclick="document.getElementById('search-form').dispatchEvent(new Event('submit'))" style="margin-top:1rem; padding:0.6rem 1.5rem; background:linear-gradient(135deg,#10b981,#059669); color:white; border:none; border-radius:20px; cursor:pointer; font-size:0.95rem; font-family:inherit;">إعادة المحاولة 🔄</button>
            `;
            errorState.classList.remove('hidden');
        }
    }

    function renderHistory() {
        if (searchHistory.length === 0) {
            historyContainer.classList.add('hidden');
            return;
        }
        historyContainer.classList.remove('hidden');
        historyItemsWrapper.innerHTML = '';
        searchHistory.forEach((query) => {
            const pill = document.createElement('button');
            pill.className = 'history-pill';
            pill.innerHTML = `
                <span>${query}</span>
                <span class="delete-history-item" data-query="${query}">&times;</span>
            `;
            
            // Search on click
            pill.addEventListener('click', (e) => {
                if (e.target.classList.contains('delete-history-item')) return;
                searchInput.value = query;
                performSearch(query);
            });

            // Delete single history item
            pill.querySelector('.delete-history-item').addEventListener('click', (e) => {
                e.stopPropagation();
                searchHistory = searchHistory.filter(q => q !== query);
                localStorage.setItem('tawfeery_history', JSON.stringify(searchHistory));
                renderHistory();
            });

            historyItemsWrapper.appendChild(pill);
        });
    }

    function buildCard(item, delayIndex = 0) {
        const clone = cardTemplate.content.cloneNode(true);
        const card  = clone.querySelector('.result-card');

        // Animations and Styles
        card.style.animationDelay = `${(delayIndex % 8) * 0.05}s`;
        card.classList.add('card-enter');

        // Image
        const img = clone.querySelector('.product-image');
        img.src = item.image || '';
        img.alt = item.name;
        img.onerror = () => {
            img.style.display = 'none';
            img.parentElement.style.background = 'var(--bg-secondary)';
        };

        // Text & Links
        clone.querySelector('.product-name').textContent = item.name;
        
        // ── Price Processing ──
        const regularPrice = parseFloat(item.price);
        const promoInfo = getPromoInfo(regularPrice, item.offer);
        const priceValEl = clone.querySelector('.price-value');
        const strikeValEl = clone.querySelector('.price-value-strikethrough');
        const promoTagEl = clone.querySelector('.promo-price-tag');
        
        if (promoInfo && promoInfo.type === 'info' && promoInfo.originalPrice > regularPrice) {
            const saving = promoInfo.originalPrice - promoInfo.unitPrice;
            priceValEl.textContent = promoInfo.unitPrice.toFixed(2);
            strikeValEl.textContent = promoInfo.originalPrice.toFixed(2);
            strikeValEl.classList.remove('hidden');
            const pct = Math.round((saving / promoInfo.originalPrice) * 100);
            promoTagEl.innerHTML = `🏷️ خصم ${pct}% (وفّر ${saving.toFixed(2)} SAR)`;
            promoTagEl.classList.remove('hidden');
            promoTagEl.style.color = '#34d399';
            promoTagEl.style.borderColor = 'rgba(52,211,153,0.3)';
            promoTagEl.style.background = 'rgba(16,185,129,0.1)';
        } else if (promoInfo && promoInfo.type === 'discount' && promoInfo.unitPrice < regularPrice) {
            const saving = regularPrice - promoInfo.unitPrice;
            priceValEl.textContent = promoInfo.unitPrice.toFixed(2);
            strikeValEl.textContent = regularPrice.toFixed(2);
            strikeValEl.classList.remove('hidden');
            promoTagEl.innerHTML = `🏷️ خصم ${Math.round(promoInfo.pct * 100)}% (وفّر ${saving.toFixed(2)} SAR)`;
            promoTagEl.classList.remove('hidden');
            promoTagEl.style.color = '#34d399';
            promoTagEl.style.borderColor = 'rgba(52,211,153,0.3)';
            promoTagEl.style.background = 'rgba(16,185,129,0.1)';
        } else if (promoInfo && promoInfo.type === 'bundle' && promoInfo.unitPrice < regularPrice) {
            // Bundle deal: show effective unit price as main price with strikethrough
            priceValEl.textContent = promoInfo.unitPrice.toFixed(2);
            strikeValEl.textContent = regularPrice.toFixed(2);
            strikeValEl.classList.remove('hidden');
            // If this is a percentage-off-second deal, show the pct in the label
            const pctLabel = promoInfo.pct !== undefined
                ? `🏷️ خصم ${Math.round(promoInfo.pct * 100)}% على الحبة الثانية — سعر الحبة بالعرض: ${promoInfo.unitPrice.toFixed(2)} SAR`
                : `🏷️ سعر الحبة بالعرض: ${promoInfo.unitPrice.toFixed(2)} SAR`;
            promoTagEl.textContent = pctLabel;
            promoTagEl.classList.remove('hidden');
            promoTagEl.style.color = '';
            promoTagEl.style.borderColor = '';
            promoTagEl.style.background = '';
        } else if (promoInfo && promoInfo.type === 'delivery' && promoInfo.deliveryPrice < regularPrice) {
            // Delivery discount: show delivery price as main price with strikethrough
            priceValEl.textContent = promoInfo.deliveryPrice.toFixed(2);
            strikeValEl.textContent = regularPrice.toFixed(2);
            strikeValEl.classList.remove('hidden');
            const saving = regularPrice - promoInfo.deliveryPrice;
            promoTagEl.innerHTML = `🚚 سعر التوصيل بالعرض: ${promoInfo.deliveryPrice.toFixed(2)} SAR (وفّر ${saving.toFixed(2)} SAR)`;
            promoTagEl.classList.remove('hidden');
            promoTagEl.style.color = '#38bdf8';
            promoTagEl.style.borderColor = 'rgba(56,189,248,0.3)';
            promoTagEl.style.background = 'rgba(14,165,233,0.1)';
        } else {
            priceValEl.textContent = regularPrice.toFixed(2);
            strikeValEl.classList.add('hidden');
            promoTagEl.classList.add('hidden');
        }
        
        const buyBtn = clone.querySelector('.buy-btn');
        buyBtn.href = item.link;
        buyBtn.addEventListener('click', (e) => e.stopPropagation()); // prevent modal trigger

        // Store styling
        const badge = clone.querySelector('.store-badge');
        badge.textContent = item.store;
        if (item.store.includes('Nahdi'))        badge.classList.add('store-nahdi');
        else if (item.store.includes('Dawaa'))   badge.classList.add('store-dawaa');
        else if (item.store.includes('United'))  badge.classList.add('store-united');
        else if (item.store.includes('Moaz'))    badge.classList.add('store-moaz');
        else if (item.store.includes('PharmaBrand')) badge.classList.add('store-pharmabrand');

        // Offer
        const offerBadge = clone.querySelector('.offer-badge');
        if (item.offer) {
            offerBadge.textContent = `🎁 ${item.offer}`;
            offerBadge.classList.remove('hidden');
        } else {
            offerBadge.classList.add('hidden');
        }

        // Favorites Button State
        const favBtn = clone.querySelector('.favorite-btn');
        const isFav = favorites.some(f => f.link === item.link);
        if (isFav) favBtn.classList.add('active');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(item, favBtn);
        });

        // Basket Button State
        const bskBtn = clone.querySelector('.basket-btn');
        const inBsk = basket.some(b => b.link === item.link);
        if (inBsk) {
            bskBtn.style.background = 'rgba(16, 185, 129, 0.2)';
            bskBtn.style.borderColor = 'var(--primary-color)';
        }
        bskBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleBasket(item, bskBtn);
        });

        // Trigger Detailed Modal on Card click (excluding button clicks)
        card.addEventListener('click', () => openModal(item));

        return clone;
    }

    let currentMagicFilter = 'all';
    let magicBestLinks = new Set();

    function isMagicBest(item) {
        return magicBestLinks.has(item.link);
    }

    function computeMagicBest() {
        magicBestLinks.clear();
        // For each item, check if any equivalent in other stores is cheaper (effective price)
        for (const item of allResults) {
            const myPrice = getEffectiveUnitPriceForSorting(parseFloat(item.price), item.offer);
            let isBest = true;
            // Find equivalents in other stores for this item
            const otherStores = ['Nahdi Online','Al-Dawaa','United Pharmacy','Moaz Pharma','PharmaBrand'].filter(s => s !== item.store);
            for (const storeKey of otherStores) {
                const storeCache = allResults.filter(r => r.store === storeKey);
                const equiv = findEquivalent(item, storeCache);
                if (equiv) {
                    const eqPrice = getEffectiveUnitPriceForSorting(parseFloat(equiv.price), equiv.offer);
                    if (eqPrice < myPrice - 0.01) { // tolerance 1 halala
                        isBest = false;
                        break;
                    }
                }
            }
            if (isBest) magicBestLinks.add(item.link);
        }
    }

    function resortGrid() {
        // Sort results by effective unit price (low to high)
        allResults.sort((a, b) => {
            const priceA = getEffectiveUnitPriceForSorting(parseFloat(a.price), a.offer);
            const priceB = getEffectiveUnitPriceForSorting(parseFloat(b.price), b.offer);
            return priceA - priceB;
        });
        computeMagicBest();
        renderMagicAnalysis();
        applyMagicFilter(currentMagicFilter, true);
    }

    function renderGridItems(items) {
        resultsGrid.innerHTML = '';
        items.forEach((item, idx) => {
            const cardClone = buildCard(item, idx);
            // Highlight magic best
            if (isMagicBest(item)) {
                const badge = cardClone.querySelector('.best-price-badge');
                if (badge) {
                    badge.textContent = '✨ الأوفر';
                    badge.classList.remove('hidden');
                }
                const card = cardClone.querySelector('.result-card');
                if (card) {
                    card.style.borderColor = 'rgba(245,158,11,0.4)';
                    card.style.boxShadow = '0 0 20px rgba(245,158,11,0.15)';
                }
            } else if (items === allResults && idx === 0) {
                // Fallback for all view: highlight absolute cheapest
                const badge = cardClone.querySelector('.best-price-badge');
                if (badge) badge.classList.remove('hidden');
                const card = cardClone.querySelector('.result-card');
                if (card) {
                    card.style.borderColor = 'rgba(16, 185, 129, 0.4)';
                    card.style.boxShadow = '0 0 25px rgba(16, 185, 129, 0.2)';
                }
            }
            resultsGrid.appendChild(cardClone);
        });
        resultsCount.textContent = items.length;
    }

    function applyMagicFilter(filter, skipTabUpdate=false) {
        currentMagicFilter = filter;
        if (!skipTabUpdate) {
            document.querySelectorAll('.magic-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));
        } else {
            document.querySelectorAll('.magic-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));
        }
        let toShow;
        if (filter === 'all') toShow = allResults;
        else if (filter === 'best') toShow = allResults.filter(isMagicBest);
        else toShow = allResults.filter(r => r.store === filter);
        if (toShow.length === 0) {
            resultsGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:2.5rem;color:var(--text-muted);background:rgba(255,255,255,0.02);border:1px dashed var(--border-color);border-radius:var(--radius-md);">لا توجد نتائج في <strong>${filter}</strong> لهذا البحث — جرّب تبويب آخر 🔍</div>`;
            resultsCount.textContent = '0';
            const insight = document.getElementById('magic-insight');
            if (insight) insight.textContent = 'لا توجد منتجات مطابقة لهذا الفلتر.';
            return;
        }
        // Sort filtered by effective price
        toShow = [...toShow].sort((a,b) => getEffectiveUnitPriceForSorting(parseFloat(a.price),a.offer) - getEffectiveUnitPriceForSorting(parseFloat(b.price),b.offer));
        renderGridItems(toShow);
        // Update insight
        const insight = document.getElementById('magic-insight');
        if (insight) {
            if (filter === 'all') {
                const bestStore = getWinnerStore();
                insight.innerHTML = `إجمالي <strong>${allResults.length}</strong> منتج من <strong>5 صيدليات</strong> — الأوفر: <span class="insight-winner">${bestStore.name}</span> بمتوسط <strong>${bestStore.avg.toFixed(2)} SAR</strong>`;
            } else if (filter === 'best') {
                insight.textContent = `✨ ${toShow.length} منتج هم الأوفر سعراً مقارنة بالبدائل في الصيدليات الأخرى`;
            } else {
                const avg = toShow.reduce((s,i)=> s+ getEffectiveUnitPriceForSorting(parseFloat(i.price),i.offer),0)/toShow.length;
                const min = Math.min(...toShow.map(i=> getEffectiveUnitPriceForSorting(parseFloat(i.price),i.offer)));
                insight.textContent = `${filter}: ${toShow.length} منتج — من ${min.toFixed(2)} SAR إلى ${getEffectiveUnitPriceForSorting(parseFloat(toShow[toShow.length-1].price),toShow[toShow.length-1].offer).toFixed(2)} SAR (متوسط ${avg.toFixed(2)} SAR)`;
            }
        }
    }

    function getWinnerStore() {
        const stores = ['Nahdi Online','Al-Dawaa','United Pharmacy','Moaz Pharma','PharmaBrand'];
        let best = null;
        let bestAvg = Infinity;
        for (const s of stores) {
            const items = allResults.filter(r=> r.store===s);
            if (!items.length) continue;
            const avg = items.reduce((sum,i)=> sum + getEffectiveUnitPriceForSorting(parseFloat(i.price),i.offer),0)/items.length;
            if (avg < bestAvg) { bestAvg = avg; best = s; }
        }
        const nameMap = {'Nahdi Online':'النهدي','Al-Dawaa':'الدواء','United Pharmacy':'المتحدة','Moaz Pharma':'معاذ','PharmaBrand':'فارما'};
        return { name: best ? nameMap[best] : 'غير محدد', avg: bestAvg, store: best };
    }

    function renderMagicAnalysis() {
        const container = document.getElementById('magic-analysis');
        const summary = document.getElementById('magic-summary');
        if (!container || !summary) return;
        if (!allResults.length) { container.classList.add('hidden'); return; }
        container.classList.remove('hidden');

        // Counts per store
        const stores = [
            { key:'Nahdi Online', label:'النهدي', cls:'nahdi' },
            { key:'Al-Dawaa', label:'الدواء', cls:'dawaa' },
            { key:'United Pharmacy', label:'المتحدة', cls:'united' },
            { key:'Moaz Pharma', label:'معاذ', cls:'moaz' },
            { key:'PharmaBrand', label:'فارما', cls:'pharmabrand' },
        ];
        // Update tab counts
        document.getElementById('tab-count-all').textContent = allResults.length;
        document.getElementById('tab-count-best').textContent = magicBestLinks.size;
        for (const s of stores) {
            const c = allResults.filter(r=> r.store===s.key).length;
            const el = document.getElementById(`tab-count-${s.cls}`);
            if (el) el.textContent = c;
        }
        // Find winner for summary highlight
        const winner = getWinnerStore();
        // Build summary cards
        summary.innerHTML = '';
        for (const s of stores) {
            const items = allResults.filter(r=> r.store===s.key);
            const count = items.length;
            let priceTxt = '—';
            let subTxt = 'لا يوجد';
            if (count) {
                const effPrices = items.map(i=> getEffectiveUnitPriceForSorting(parseFloat(i.price),i.offer));
                const min = Math.min(...effPrices);
                const avg = effPrices.reduce((a,b)=>a+b,0)/effPrices.length;
                priceTxt = `${min.toFixed(2)} <small>SAR</small>`;
                subTxt = `${count} منتج • متوسط ${avg.toFixed(2)}`;
            }
            const isWinner = winner.store === s.key;
            const div = document.createElement('div');
            div.className = `magic-store-card ${isWinner ? 'winner' : ''}`;
            div.innerHTML = `<div class="magic-store-name"><span class="store-dot ${s.cls}"></span>${s.label}</div><div class="magic-store-price">${priceTxt}</div><div class="magic-store-count">${subTxt}</div>`;
            summary.appendChild(div);
        }
        // Best count card
        const bestDiv = document.createElement('div');
        bestDiv.className = 'magic-store-card';
        bestDiv.style.borderColor = 'rgba(245,158,11,0.25)';
        bestDiv.innerHTML = `<div class="magic-store-name">✨ الأوفر</div><div class="magic-store-price">${magicBestLinks.size} <small>منتج</small></div><div class="magic-store-count">الأرخص مقارنة بالبدائل</div>`;
        summary.appendChild(bestDiv);
    }


    // ── FAVORITES LOGIC ──────────────────────────────────────────────────────

    function toggleFavorite(item, btnElement) {
        const index = favorites.findIndex(f => f.link === item.link);
        if (index === -1) {
            favorites.push(item);
            btnElement.classList.add('active');
        } else {
            favorites.splice(index, 1);
            btnElement.classList.remove('active');
        }
        localStorage.setItem('tawfeery_favorites', JSON.stringify(favorites));
    }


    // ── SMART BASKET COMPARISON LOGIC ────────────────────────────────────────

    basketToggle.addEventListener('click', () => basketDrawer.classList.toggle('open'));
    basketCloseBtn.addEventListener('click', () => basketDrawer.classList.remove('open'));
    clearBasketBtn.addEventListener('click', () => {
        basket = [];
        customEquivalents = {};
        localStorage.setItem('tawfeery_basket', JSON.stringify(basket));
        localStorage.setItem('tawfeery_custom_equivalents', JSON.stringify(customEquivalents));
        updateBasketUI();
        // Reset card basket states on the grid
        document.querySelectorAll('.basket-btn').forEach(btn => {
            btn.style.background = '';
            btn.style.borderColor = '';
        });
    });

    let autoFetchInProgress = new Set();

    async function fetchEquivalentsForBasketItem(basketItem) {
        const cacheKey = basketItem.link;
        if (autoFetchInProgress.has(cacheKey)) return;
        autoFetchInProgress.add(cacheKey);
        // Build query from brand+line or first 3 tokens
        let q = '';
        if (basketItem.product_brand && basketItem.product_line) {
            q = `${basketItem.product_brand} ${basketItem.product_line}`;
        } else {
            const toks = getTokens(basketItem.name);
            q = toks.slice(0, 3).join(' ') || basketItem.name.split(' ').slice(0, 3).join(' ');
        }
        if (!q) { autoFetchInProgress.delete(cacheKey); return; }
        try {
            const res = await fetch(api(`/api/search?q=${encodeURIComponent(q)}`));
            if (!res.ok || !res.body) return;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const parts = buf.split('\n\n');
                buf = parts.pop();
                for (const line of parts) {
                    const data = line.replace(/^data: /, '').trim();
                    if (!data || data === 'DONE') continue;
                    try {
                        const parsed = JSON.parse(data);
                        const incoming = parsed.results || [];
                        let added = false;
                        incoming.forEach(it => {
                            if (!sessionScrapedProducts.some(p => p.link === it.link)) {
                                sessionScrapedProducts.push(it);
                                added = true;
                            }
                        });
                        if (added) {
                            localStorage.setItem('tawfeery_scraped_cache', JSON.stringify(sessionScrapedProducts));
                            updateBasketUI();
                        }
                    } catch {}
                }
            }
        } catch (e) {
            console.warn('auto-fetch equivalents failed', e);
        } finally {
            autoFetchInProgress.delete(cacheKey);
            updateBasketUI();
        }
    }

    function toggleBasket(item, btnElement) {
        const index = basket.findIndex(b => b.link === item.link);
        if (index === -1) {
            // Add with default quantity of 1
            const basketItem = { ...item, productQty: item.quantity, quantity: 1 };
            basket.push(basketItem);
            if (btnElement) {
                btnElement.style.background = 'rgba(16, 185, 129, 0.2)';
                btnElement.style.borderColor = 'var(--primary-color)';
            }
            localStorage.setItem('tawfeery_basket', JSON.stringify(basket));
            updateBasketUI();
            // Auto-fetch equivalents in background if added from deals/home (missing in cache)
            fetchEquivalentsForBasketItem(basketItem);
        } else {
            basket.splice(index, 1);
            if (btnElement) {
                btnElement.style.background = '';
                btnElement.style.borderColor = '';
            }
            localStorage.setItem('tawfeery_basket', JSON.stringify(basket));
            updateBasketUI();
        }
    }

    function updateBasketUI() {
        basketCount.textContent = basket.reduce((acc, b) => acc + (b.quantity || 1), 0);

        if (basket.length === 0) {
            basketItemsList.innerHTML = `
                <div class="empty-basket-state">
                    <div class="basket-icon-large">🛒</div>
                    <p>سلتك فارغة حالياً. أضف منتجات من نتائج البحث لمقارنة الأسعار الإجمالية بين الصيدليات.</p>
                </div>
            `;
            basketDashboard.classList.add('hidden');
            return;
        }

        basketDashboard.classList.remove('hidden');
        basketItemsList.innerHTML = '';

        basket.forEach((item) => {
            const div = document.createElement('div');
            div.className = 'basket-item';
            
            const regularPrice = parseFloat(item.price);
            const promoPrice = getEffectiveUnitPrice(regularPrice, item.offer);
            const displayUnitPrice = (promoPrice !== null && promoPrice < regularPrice) ? promoPrice : regularPrice;
            const q = item.quantity || 1;

            const storesToCompare = [
                { name: 'صيدلية النهدي', key: 'Nahdi Online', class: 'nahdi', short: 'النهدي' },
                { name: 'صيدلية الدواء', key: 'Al-Dawaa', class: 'dawaa', short: 'الدواء' },
                { name: 'المتحدة', key: 'United Pharmacy', class: 'united', short: 'المتحدة' },
                { name: 'صيدلية معاذ', key: 'Moaz Pharma', class: 'moaz', short: 'معاذ' },
                { name: 'فارما براند', key: 'PharmaBrand', class: 'pharmabrand', short: 'فارما' }
            ];

            let equivalentsHTML = '';
            storesToCompare.forEach(store => {
                if (item.store === store.key) {
                    return; // Skip native store
                }

                // Check if custom bound equivalent exists
                const customLink = customEquivalents[item.link]?.[store.key];
                let equiv = null;
                if (customLink) {
                    equiv = sessionScrapedProducts.find(p => p.link === customLink);
                }

                // If not custom bound, check auto-matching in cache
                if (!equiv) {
                    const storeCache = sessionScrapedProducts.filter(r => r.store.includes(store.key.split(' ')[0]));
                    equiv = findEquivalent(item, storeCache);
                }

                if (equiv) {
                    const isCustom = !!customLink;
                    const equivPromo = getPromoInfo(parseFloat(equiv.price), equiv.offer);
                    const equivEffectiveUnit = (equivPromo && equivPromo.type === 'info') ? equivPromo.unitPrice
                        : (equivPromo && equivPromo.type === 'bundle' && equivPromo.unitPrice < parseFloat(equiv.price))
                        ? equivPromo.unitPrice
                        : (equivPromo && equivPromo.type === 'delivery' ? equivPromo.deliveryPrice : parseFloat(equiv.price));
                    const equivOfferBadge = (equivPromo && equivEffectiveUnit < parseFloat(equiv.price))
                        ? `<span style="font-size:0.65rem; color:#10b981; margin-right:0.2rem;" title="${equiv.offer || ''}">🏷️ ${equivEffectiveUnit.toFixed(2)} SAR/حبة</span>`
                        : '';
                    equivalentsHTML += `
                        <div class="basket-custom-equiv-row">
                            <span class="store-dot ${store.class}"></span>
                            <span style="font-size: 0.72rem; color: var(--text-muted);">${store.short}:</span>
                            <span class="bound-equiv-name" title="${equiv.name}">${equiv.name} (${equiv.price.toFixed(2)} SAR${equivOfferBadge ? '' : ''})</span>
                            ${equivOfferBadge}
                            ${isCustom ? `<button class="unbind-equiv-btn" data-basket-link="${item.link}" data-store="${store.key}" title="إلغاء الربط المخصص">&times;</button>` : ''}
                        </div>
                    `;
                } else {
                    // If background fetch is running, show searching state
                    if (autoFetchInProgress.has(item.link)) {
                        equivalentsHTML += `
                            <div class="basket-missing-equiv-row">
                                <span class="store-dot ${store.class}"></span>
                                <span style="font-size:0.72rem; color:#38bdf8;">${store.short}: جاري البحث...</span>
                                <span class="spinner" style="width:12px;height:12px;border-width:2px;margin:0 0.4rem 0 0;"></span>
                            </div>
                        `;
                    } else {
                    // Search session cache for same-brand suggestions
                    const storeCache = sessionScrapedProducts.filter(r => r.store.includes(store.key.split(' ')[0]));
                    const itemTokens = getTokens(item.name);
                    const brand = itemTokens[0];
                    
                    const candidates = storeCache.filter(cand => {
                        const candTokens = getTokens(cand.name);
                        return candTokens.includes(brand);
                    }).slice(0, 2);

                    if (candidates.length > 0) {
                        const pillsHTML = candidates.map(c => `
                            <button class="suggest-pill-btn" data-basket-link="${item.link}" data-store="${store.key}" data-equiv-link="${c.link}" title="${c.name}">
                                ${c.name.substring(0, 15)}... (${c.price.toFixed(2)} SAR)
                            </button>
                        `).join('');
                        
                        equivalentsHTML += `
                            <div class="basket-missing-equiv-row">
                                <span class="store-dot ${store.class}"></span>
                                <span style="font-size: 0.72rem; color: #ef4444; margin-left: 0.2rem;">${store.short} (نقص):</span>
                                <div class="suggest-pills-container">
                                    ${pillsHTML}
                                </div>
                            </div>
                        `;
                    } else {
                        equivalentsHTML += `
                            <div class="basket-missing-equiv-row">
                                <span class="store-dot ${store.class}"></span>
                                <span style="font-size: 0.72rem; color: #ef4444;">${store.short}: غير متوفر بديل</span>
                            </div>
                        `;
                    }
                    }
                }
            });

            div.innerHTML = `
                <div style="display: flex; gap: 0.8rem; align-items: center; width: 100%;">
                    <img src="${item.image || 'https://via.placeholder.com/150'}" alt="${item.name}" class="basket-item-img" onerror="this.src='https://via.placeholder.com/150'">
                    <div class="basket-item-info">
                        <div class="basket-item-name">${item.name}</div>
                        <div class="basket-item-store">${item.store}</div>
                        <div class="basket-item-qty-controls">
                            <button class="qty-btn qty-minus">-</button>
                            <span class="qty-val">${q}</span>
                            <button class="qty-btn qty-plus">+</button>
                        </div>
                    </div>
                    <div style="text-align: right; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 0.2rem; min-width: 80px; margin-right: auto;">
                        <div class="basket-item-price-tag" style="font-size: 1rem;">${(displayUnitPrice * q).toFixed(2)} SAR</div>
                        <div style="font-size: 0.72rem; color: var(--text-muted);">${displayUnitPrice.toFixed(2)} / الحبة</div>
                    </div>
                    <button class="remove-basket-item" title="حذف" style="margin-right: 0.4rem;">&times;</button>
                </div>
                ${equivalentsHTML ? `<div class="basket-item-missing-section">${equivalentsHTML}</div>` : ''}
            `;
            div.style.flexDirection = 'column';
            div.style.alignItems = 'flex-start';

            // Quantity adjust event listeners
            div.querySelector('.qty-plus').addEventListener('click', () => {
                item.quantity = q + 1;
                localStorage.setItem('tawfeery_basket', JSON.stringify(basket));
                updateBasketUI();
            });

            div.querySelector('.qty-minus').addEventListener('click', () => {
                if (q > 1) {
                    item.quantity = q - 1;
                    localStorage.setItem('tawfeery_basket', JSON.stringify(basket));
                    updateBasketUI();
                }
            });

            div.querySelector('.remove-basket-item').addEventListener('click', () => {
                toggleBasket(item, null);
                // Synchronize search grid button highlights if visible
                const cards = resultsGrid.querySelectorAll('.result-card');
                cards.forEach(card => {
                    const buyBtn = card.querySelector('.buy-btn');
                    if (buyBtn && buyBtn.href === item.link) {
                        const bskBtn = card.querySelector('.basket-btn');
                        if (bskBtn) {
                            bskBtn.style.background = '';
                            bskBtn.style.borderColor = '';
                        }
                    }
                });
            });

            // Equivalent pills binding listeners
            div.querySelectorAll('.suggest-pill-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const bLink = btn.getAttribute('data-basket-link');
                    const storeKey = btn.getAttribute('data-store');
                    const equivLink = btn.getAttribute('data-equiv-link');
                    
                    if (!customEquivalents[bLink]) {
                        customEquivalents[bLink] = {};
                    }
                    customEquivalents[bLink][storeKey] = equivLink;
                    localStorage.setItem('tawfeery_custom_equivalents', JSON.stringify(customEquivalents));
                    updateBasketUI();
                });
            });

            // Unbind listeners
            div.querySelectorAll('.unbind-equiv-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const bLink = btn.getAttribute('data-basket-link');
                    const storeKey = btn.getAttribute('data-store');
                    
                    if (customEquivalents[bLink] && customEquivalents[bLink][storeKey]) {
                        delete customEquivalents[bLink][storeKey];
                        if (Object.keys(customEquivalents[bLink]).length === 0) {
                            delete customEquivalents[bLink];
                        }
                    }
                    localStorage.setItem('tawfeery_custom_equivalents', JSON.stringify(customEquivalents));
                    updateBasketUI();
                });
            });

            basketItemsList.appendChild(div);
        });

        calculateTotals();
    }

    function calculateTotals() {
        // Group all scraped cache results by store
        const storeResults = {
            'Nahdi Online':    sessionScrapedProducts.filter(r => r.store.includes('Nahdi')),
            'Al-Dawaa':        sessionScrapedProducts.filter(r => r.store.includes('Dawaa')),
            'United Pharmacy': sessionScrapedProducts.filter(r => r.store.includes('United')),
            'Moaz Pharma':     sessionScrapedProducts.filter(r => r.store.includes('Moaz')),
            'PharmaBrand':     sessionScrapedProducts.filter(r => r.store.includes('PharmaBrand'))
        };

        let nahdiTotal  = 0;
        let dawaaTotal  = 0;
        let unitedTotal = 0;
        let moazTotal   = 0;
        let pharmaTotal = 0;

        let missingNahdi  = 0;
        let missingDawaa  = 0;
        let missingUnited = 0;
        let missingMoaz   = 0;
        let missingPharma = 0;

        basket.forEach((basketItem) => {
            const q = basketItem.quantity || 1;

            // ── Nahdi Online Equivalent
            if (basketItem.store.includes('Nahdi')) {
                nahdiTotal += calculateDiscountedPrice(basketItem.price, basketItem.offer, q);
            } else {
                let equiv = null;
                const customLink = customEquivalents[basketItem.link]?.[ 'Nahdi Online' ];
                if (customLink) {
                    equiv = sessionScrapedProducts.find(p => p.link === customLink);
                }
                if (!equiv) {
                    equiv = findEquivalent(basketItem, storeResults['Nahdi Online']);
                }
                
                if (equiv) {
                    nahdiTotal += calculateDiscountedPrice(equiv.price, equiv.offer, q);
                } else {
                    missingNahdi += q;
                }
            }

            // ── Al-Dawaa Equivalent
            if (basketItem.store.includes('Dawaa')) {
                dawaaTotal += calculateDiscountedPrice(basketItem.price, basketItem.offer, q);
            } else {
                let equiv = null;
                const customLink = customEquivalents[basketItem.link]?.[ 'Al-Dawaa' ];
                if (customLink) {
                    equiv = sessionScrapedProducts.find(p => p.link === customLink);
                }
                if (!equiv) {
                    equiv = findEquivalent(basketItem, storeResults['Al-Dawaa']);
                }
                
                if (equiv) {
                    dawaaTotal += calculateDiscountedPrice(equiv.price, equiv.offer, q);
                } else {
                    missingDawaa += q;
                }
            }

            // ── United Pharmacy Equivalent
            if (basketItem.store.includes('United')) {
                unitedTotal += calculateDiscountedPrice(basketItem.price, basketItem.offer, q);
            } else {
                let equiv = null;
                const customLink = customEquivalents[basketItem.link]?.[ 'United Pharmacy' ];
                if (customLink) {
                    equiv = sessionScrapedProducts.find(p => p.link === customLink);
                }
                if (!equiv) {
                    equiv = findEquivalent(basketItem, storeResults['United Pharmacy']);
                }
                
                if (equiv) {
                    unitedTotal += calculateDiscountedPrice(equiv.price, equiv.offer, q);
                } else {
                    missingUnited += q;
                }
            }

            // ── Moaz Pharma Equivalent
            if (basketItem.store.includes('Moaz')) {
                moazTotal += calculateDiscountedPrice(basketItem.price, basketItem.offer, q);
            } else {
                let equiv = null;
                const customLink = customEquivalents[basketItem.link]?.[ 'Moaz Pharma' ];
                if (customLink) {
                    equiv = sessionScrapedProducts.find(p => p.link === customLink);
                }
                if (!equiv) {
                    equiv = findEquivalent(basketItem, storeResults['Moaz Pharma']);
                }
                if (equiv) {
                    moazTotal += calculateDiscountedPrice(equiv.price, equiv.offer, q);
                } else {
                    missingMoaz += q;
                }
            }

            // ── PharmaBrand Equivalent
            if (basketItem.store.includes('PharmaBrand')) {
                pharmaTotal += calculateDiscountedPrice(basketItem.price, basketItem.offer, q);
            } else {
                let equiv = null;
                const customLink = customEquivalents[basketItem.link]?.[ 'PharmaBrand' ];
                if (customLink) {
                    equiv = sessionScrapedProducts.find(p => p.link === customLink);
                }
                if (!equiv) {
                    equiv = findEquivalent(basketItem, storeResults['PharmaBrand']);
                }
                if (equiv) {
                    pharmaTotal += calculateDiscountedPrice(equiv.price, equiv.offer, q);
                } else {
                    missingPharma += q;
                }
            }
        });

        const totalItemsInBasket = basket.reduce((acc, b) => acc + (b.quantity || 1), 0);

        // Render Nahdi total
        if (missingNahdi > 0) {
            basketTotalNahdi.innerHTML = `${nahdiTotal.toFixed(2)} SAR <span style="font-size:0.75rem; color:#f87171;">(نقص ${missingNahdi})</span>`;
        } else {
            basketTotalNahdi.innerHTML = `${nahdiTotal.toFixed(2)} SAR`;
        }

        // Render Dawaa total
        if (missingDawaa > 0) {
            basketTotalDawaa.innerHTML = `${dawaaTotal.toFixed(2)} SAR <span style="font-size:0.75rem; color:#f87171;">(نقص ${missingDawaa})</span>`;
        } else {
            basketTotalDawaa.innerHTML = `${dawaaTotal.toFixed(2)} SAR`;
        }

        // Render United total
        if (missingUnited > 0) {
            basketTotalUnited.innerHTML = `${unitedTotal.toFixed(2)} SAR <span style="font-size:0.75rem; color:#f87171;">(نقص ${missingUnited})</span>`;
        } else {
            basketTotalUnited.innerHTML = `${unitedTotal.toFixed(2)} SAR`;
        }

        // Render Moaz total
        if (basketTotalMoaz) {
            if (missingMoaz > 0) {
                basketTotalMoaz.innerHTML = `${moazTotal.toFixed(2)} SAR <span style="font-size:0.75rem; color:#f87171;">(نقص ${missingMoaz})</span>`;
            } else {
                basketTotalMoaz.innerHTML = `${moazTotal.toFixed(2)} SAR`;
            }
        }

        // Render PharmaBrand total
        if (basketTotalPharma) {
            if (missingPharma > 0) {
                basketTotalPharma.innerHTML = `${pharmaTotal.toFixed(2)} SAR <span style="font-size:0.75rem; color:#f87171;">(نقص ${missingPharma})</span>`;
            } else {
                basketTotalPharma.innerHTML = `${pharmaTotal.toFixed(2)} SAR`;
            }
        }

        // Determine Winner
        const scoreNahdi  = { total: nahdiTotal,  missing: missingNahdi,  name: 'صيدلية النهدي' };
        const scoreDawaa  = { total: dawaaTotal,  missing: missingDawaa,  name: 'صيدلية الدواء' };
        const scoreUnited = { total: unitedTotal, missing: missingUnited, name: 'المتحدة' };
        const scoreMoaz   = { total: moazTotal,   missing: missingMoaz,   name: 'صيدلية معاذ' };
        const scorePharma = { total: pharmaTotal, missing: missingPharma, name: 'فارما براند' };

        const candidates = [scoreNahdi, scoreDawaa, scoreUnited, scoreMoaz, scorePharma];
        // Sort primarily by fewest missing items, then by lowest total cost
        candidates.sort((a, b) => {
            if (a.missing !== b.missing) return a.missing - b.missing;
            return a.total - b.total;
        });

        const winner = candidates[0];

        // Clear previous winner formatting
        basketTotalNahdi.classList.remove('winner');
        basketTotalDawaa.classList.remove('winner');
        basketTotalUnited.classList.remove('winner');
        if (basketTotalMoaz) basketTotalMoaz.classList.remove('winner');
        if (basketTotalPharma) basketTotalPharma.classList.remove('winner');

        if (winner.missing === totalItemsInBasket) {
            basketWinnerBanner.innerHTML = '🔍 ابحث عن أدوية لمطابقة الأسعار الإجمالية';
        } else {
            if (winner.name === 'صيدلية النهدي')  basketTotalNahdi.classList.add('winner');
            if (winner.name === 'صيدلية الدواء')  basketTotalDawaa.classList.add('winner');
            if (winner.name === 'المتحدة')        basketTotalUnited.classList.add('winner');
            if (winner.name === 'صيدلية معاذ')   basketTotalMoaz.classList.add('winner');
            if (winner.name === 'فارما براند')   basketTotalPharma.classList.add('winner');

            let bannerHTML = `🎉 <strong>${winner.name}</strong> هي الأوفر لك بإجمالي <strong>${winner.total.toFixed(2)} ريال</strong>`;
            if (winner.missing > 0) {
                bannerHTML += ` <span style="font-size:0.75rem; opacity:0.8;">(مع نقص ${winner.missing} حبة غير متوفرة)</span>`;
            }
            basketWinnerBanner.innerHTML = bannerHTML;
        }
    }


    // ── PRICE ANALYSIS ENGINE ───────────────────────────────────────────────

    /**
     * Returns structured promo info:
     * - type 'bundle': multi-buy deal, unitPrice = effective per-unit price
     * - type 'delivery': Al-Dawaa delivery discount, deliveryPrice = discounted price
     * - null: no recognized discount
     */
    function getPromoInfo(price, offer) {
        if (!offer) return null;
        const o = offer.toLowerCase();

        // Al-Dawaa delivery price pattern: "سعر التوصيل: X.XX ريال (وفّر Y.YY ريال)"
        let m = o.match(/سعر\s*التوصيل[:\s]*(\d+\.?\d*)/);
        if (m) {
            return { type: 'delivery', deliveryPrice: parseFloat(m[1]) };
        }

        // Bundle: "اشتري 2 بقيمة 1" → Buy 2 for price of 1 (1+1 free)
        if (o.includes('بقيمة 1') || (o.includes('2 بقيمة') && o.includes('1'))) {
            return { type: 'bundle', unitPrice: price / 2 };
        }

        // Bundle: Buy 2 For X / اشتري 2 بسعر X
        m = o.match(/(?:buy\s+2\s+for|اشتري\s+2\s+بسعر)\s*(\d+\.?\d*)/);
        if (m) return { type: 'bundle', unitPrice: parseFloat(m[1]) / 2 };

        // Bundle: Buy 2nd for X → effective unit = (price + X) / 2
        // Make the Kashida (ـ) optional using بـ?
        m = o.match(/(?:الحبة\s+الثانية\s+بـ?|buy\s+2nd\s+for|اشتري\s+الحبة\s+الثانية\s+بـ?)\s*(\d+\.?\d*)/);
        if (m) return { type: 'bundle', unitPrice: (price + parseFloat(m[1])) / 2 };

        // Bundle: 1+1 free (or اشتري 2 بقيمة 1)
        if (o.includes('1 + 1') || o.includes('1+1') || o.includes('بقيمة 1') || (o.includes('مجانا') && o.includes('1') && !o.includes('2')) || o.includes('حبة + حبة مجانا') || o.includes('حبة + حبة مجاناً')) {
            return { type: 'bundle', unitPrice: price / 2 };
        }

        // Bundle: 2+1 free
        if (o.includes('2 + 1') || o.includes('2+1') || (o.includes('مجانا') && o.includes('2')) || o.includes('حبتين + حبة مجانا') || o.includes('حبتين + حبة مجاناً')) {
            return { type: 'bundle', unitPrice: (price * 2) / 3 };
        }

        // Info-only: "عرض خاص (بدلاً من X SAR)" — price is already discounted, show original as strikethrough
        m = o.match(/بدل[اأ]ً?\s*من\s*(\d+\.?\d*)/);
        if (m) {
            const orig = parseFloat(m[1]);
            if (orig > price) return { type: 'info', originalPrice: orig, unitPrice: price };
        }

        // Simple discount: "خصم X%" or "وفر X%" (straight percentage off)
        m = o.match(/(?:خصم|وفر|save)\s*(\d+)\s*%/ui);
        if (m) {
            const discountPct = parseFloat(m[1]) / 100;
            const discountedPrice = price * (1 - discountPct);
            return { type: 'discount', pct: discountPct, unitPrice: discountedPrice };
        }

        // Generic: X% off second item – e.g. "خصم 30% على الحبة الثانية", "50% off second"
        m = o.match(/(?:خصم\s*)?(\d+)\s*%(?:\s*(?:على|off)?\s*(?:الحبه?\s*)?(?:الثانيه?|second))/u);
        if (!m) {
            m = o.match(/(\d+)\s*%/);
            if (m && !(o.includes('الثانيه') || o.includes('الثانية') || o.includes('second'))) {
                m = null;
            }
        }
        if (m) {
            const discountPct = parseFloat(m[1]) / 100;
            const unitPrice = (price + price * (1 - discountPct)) / 2;
            return { type: 'bundle', pct: discountPct, unitPrice };
        }

        return null;
    }

    // For sorting: bundle and delivery deals affect the comparison price
    function getEffectiveUnitPriceForSorting(price, offer) {
        const info = getPromoInfo(price, offer);
        if (info) {
            if (info.type === 'info') return info.unitPrice;
            if (info.type === 'bundle') return info.unitPrice;
            if (info.type === 'delivery') return info.deliveryPrice;
        }
        return price;
    }

    // Returns effective unit price for bundle or delivery deals
    function getEffectiveUnitPrice(price, offer) {
        const info = getPromoInfo(price, offer);
        if (info) {
            if (info.type === 'info') return info.unitPrice;
            if (info.type === 'bundle') return info.unitPrice;
            if (info.type === 'delivery') return info.deliveryPrice;
        }
        return null;
    }

    function calculateDiscountedPrice(price, offer, quantity) {
        if (!offer || quantity <= 0) return price * quantity;
        const info = getPromoInfo(price, offer);
        if (!info) return price * quantity;

        if (info.type === 'bundle') {
            const o = offer.toLowerCase();

            // Buy 2 for price of 1 (اشتري 2 بقيمة 1 = 1+1 free)
            if (o.includes('بقيمة 1') || (o.includes('2 بقيمة') && o.includes('1'))) {
                const pairs = Math.floor(quantity / 2);
                const singles = quantity % 2;
                return (pairs + singles) * price;
            }

            // Buy 2 For X
            let m = o.match(/(?:buy\s+2\s+for|اشتري\s+2\s+بسعر|اشتري\s+2\s+بقيمة)\s*(\d+\.?\d*)/);
            if (m) {
                const promoPrice = parseFloat(m[1]);
                const pairs = Math.floor(quantity / 2);
                const singles = quantity % 2;
                return (pairs * promoPrice) + (singles * price);
            }

            // Buy 2nd for X
            // Make the Kashida (ـ) optional using بـ?
            m = o.match(/(?:الحبة\s+الثانية\s+بـ?|buy\s+2nd\s+for|اشتري\s+الحبة\s+الثانية\s+بـ?)\s*(\d+\.?\d*)/);
            if (m) {
                const secondPrice = parseFloat(m[1]);
                const pairs = Math.floor(quantity / 2);
                const singles = quantity % 2;
                return pairs * (price + secondPrice) + (singles * price);
            }

            // 1+1 free (or "اشتري 2 بقيمة 1")
            if (o.includes('1 + 1') || o.includes('1+1') || o.includes('بقيمة 1') || (o.includes('مجانا') && o.includes('1') && !o.includes('2')) || o.includes('حبة + حبة مجانا') || o.includes('حبة + حبة مجاناً')) {
                const pairs = Math.floor(quantity / 2);
                const singles = quantity % 2;
                return (pairs + singles) * price;
            }

            // 2+1 free
            if (o.includes('2 + 1') || o.includes('2+1') || (o.includes('مجانا') && o.includes('2')) || o.includes('حبتين + حبة مجانا') || o.includes('حبتين + حبة مجاناً')) {
                const triplets = Math.floor(quantity / 3);
                const remainder = quantity % 3;
                return (triplets * 2 + remainder) * price;
            }

            // Generic X% off second item – use pct stored in promoInfo if available
            if (info.pct !== undefined) {
                const discountPct = info.pct;
                const pairs = Math.floor(quantity / 2);
                const singles = quantity % 2;
                // each pair: full price + second at (1-pct) price
                return pairs * (price + price * (1 - discountPct)) + (singles * price);
            }

            // Legacy fallback: 50% off second (in case pct wasn't captured above)
            if (o.includes('50%') || o.includes('50 %')) {
                const pairs = Math.floor(quantity / 2);
                const singles = quantity % 2;
                return pairs * (price + price * 0.5) + (singles * price);
            }
        } else if (info.type === 'info') {
            return info.unitPrice * quantity;
        } else if (info.type === 'discount') {
            return info.unitPrice * quantity;
        } else if (info.type === 'delivery') {
            return info.deliveryPrice * quantity;
        }

        return price * quantity;
    }


    // ── SMART IMAGE-FIRST COMPARISON ENGINE ──────────────────────────────────

    function hammingDistanceHex(h1, h2) {
        if (!h1 || !h2 || h1.length !== 16 || h2.length !== 16) return 999;
        try {
            const n1 = BigInt('0x' + h1);
            const n2 = BigInt('0x' + h2);
            let x = n1 ^ n2;
            let count = 0;
            while (x) { count += Number(x & 1n); x >>= 1n; }
            return count;
        } catch { return 999; }
    }

    // ── FUZZY STRING MATCHING ENGINE ─────────────────────────────────────────

    function cleanName(name) {
        if (!name) return '';
        // Remove Arabic tatweer/kashida completely
        let cleaned = name.toLowerCase().replace(/ـ/g, '');
        // Normalize Arabic letters and remove minor characters/brackets/punctuation
        return cleaned
            .replace(/[أإآأ]/g, 'ا')
            .replace(/ة/g, 'ه')
            .replace(/ى/g, 'ي')
            .replace(/[،؛؟?–—:;!*&|"'\-_.,()\/\[\]+]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getTokens(name) {
        const cleaned = cleanName(name);
        const stopWords = new Set([
            'علبه', 'قرص', 'كبسوله', 'مل', 'جم', 'حبة', 'حبة/', 'حبات', 'ملج', 'جرام',
            'tablets', 'capsules', 'tabs', 'cap', 'ml', 'mg', 'g', 'pack', 'pcs', 'tablet', 'capsule',
            'من', 'مع', 'في', 'ال', 'ar', 'en', 'او', 'أو', 'ام', 'أم', 'على', 'عن'
        ]);
        return cleaned.split(' ').map(t => {
            let token = t;
            // Strip Arabic definite article "ال" if length allows
            if (token.startsWith('ال') && token.length > 4) {
                token = token.substring(2);
            }
            // Strip Arabic prefix "لل" (for/to the) if length allows
            if (token.startsWith('لل') && token.length > 4) {
                token = token.substring(2);
            }
            return token;
        }).filter(t => t.length > 1 && !stopWords.has(t));
    }

    function findEquivalent(item, otherStoreResults) {
        const _itemQty = item.productQty || item.quantity;

        function cosineSim(a, b) {
            if (!a || !b || a.length !== b.length) return 0;
            let dot = 0, na = 0, nb = 0;
            for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
            return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
        }

        function lineMismatch(a, b) {
            const al = a.product_line || '';
            const bl = b.product_line || '';
            if (al && bl && al !== bl) return true;
            return false;
        }

        function sizeMismatch(a, b) {
            const as = a.product_size || '';
            const bs = b.product_size || '';
            if (as && bs && as !== bs) return true;
            return false;
        }

        let bestMatch = null;
        let bestTotal = -1;

        for (const candidate of otherStoreResults) {
            const candidateTokens = getTokens(candidate.name);
            if (candidateTokens.length === 0) continue;

            // ── HARD FILTERS ─────────────────────────────────────────
            // 1. Product line mismatch → reject (Sebium ≠ Sensibio ≠ Cicabio)
            if (lineMismatch(item, candidate)) continue;
            // 2. Quantity mismatch
            if (_itemQty && candidate.quantity && _itemQty !== candidate.quantity) continue;
            // 3. Variant mismatch (soap vs gel)
            const candVariants = getVariantTokens(candidate.name);
            const itemVariants = getVariantTokens(item.name);
            if (hasVariantMismatch(itemVariants, candVariants)) continue;

            // ── SCORING SIGNALS ──────────────────────────────────────
            let total = 0;

            // Signal 1: AI Embedding similarity (weight 40%)
            const embScore = cosineSim(item.embedding, candidate.embedding);
            total += embScore * 0.40;

            // Signal 2: Token overlap / Jaccard (weight 25%)
            const itemTokens = getTokens(item.name);
            let intersection = 0;
            for (const t of itemTokens) { if (candidateTokens.includes(t)) intersection++; }
            const overlapScore = intersection / Math.min(itemTokens.length, candidateTokens.length) || 0;
            const jaccard = intersection / (itemTokens.length + candidateTokens.length - intersection) || 0;
            const tokenScore = overlapScore * 0.7 + jaccard * 0.3;
            total += tokenScore * 0.25;

            // Signal 3: Image hash similarity (weight 25%)
            if (item.image_hash && candidate.image_hash) {
                const dist = hammingDistanceHex(item.image_hash, candidate.image_hash);
                const imgScore = Math.max(0, (20 - dist) / 20);
                total += imgScore * 0.25;
            }

            // Signal 4: Product-line exact match bonus (weight 10%)
            if (item.product_line && candidate.product_line && item.product_line === candidate.product_line) {
                total += 0.10;
            } else if (item.product_line && candidate.product_line && item.product_line !== candidate.product_line) {
                continue; // already filtered above, belt-and-suspenders
            }

            // Signal 5: Size match bonus
            if (item.product_size && candidate.product_size && item.product_size === candidate.product_size) {
                total += 0.05;
            }

            // ── BRAND PROTECTION ─────────────────────────────────────
            const brand = itemTokens[0];
            if (candidateTokens[0] !== brand) {
                if (!candidateTokens.includes(brand) && !itemTokens.includes(candidateTokens[0])) {
                    // Neither side has the other's brand → penalize heavily
                    total *= 0.3;
                }
            }

            if (total > bestTotal) {
                bestTotal = total;
                bestMatch = candidate;
            }
        }

        // Minimum threshold: require solid evidence (raised from 0.25 to avoid Carsia vs Maxon false matches)
        if (bestMatch && bestTotal >= 0.38) return bestMatch;
        return null;
    }


    // ── PRODUCT DETAILS MODAL ────────────────────────────────────────────────

    function openModal(item) {
        modalProductImg.src = item.image || '';
        modalProductImg.onerror = () => {
            modalProductImg.src = 'https://via.placeholder.com/200?text=No+Image';
        };

        modalProductTitle.textContent = item.name;
        
        // Show price & promo info in modal
        const regularPrice = parseFloat(item.price);
        const promoInfo = getPromoInfo(regularPrice, item.offer);
        
        if (promoInfo && promoInfo.type === 'info' && promoInfo.originalPrice > regularPrice) {
            const saving = promoInfo.originalPrice - promoInfo.unitPrice;
            const pct = Math.round((saving / promoInfo.originalPrice) * 100);
            modalPriceValue.innerHTML = `${promoInfo.unitPrice.toFixed(2)} SAR <span style="font-size: 0.95rem; text-decoration: line-through; color: var(--text-muted); font-weight: normal; margin-right: 0.5rem;">${promoInfo.originalPrice.toFixed(2)} SAR</span> <div style="font-size:0.75rem; color:#34d399; margin-top:0.25rem;">🏷️ خصم ${pct}% (وفّر ${saving.toFixed(2)} SAR)</div>`;
        } else if (promoInfo && promoInfo.type === 'discount' && promoInfo.unitPrice < regularPrice) {
            const saving = regularPrice - promoInfo.unitPrice;
            modalPriceValue.innerHTML = `${promoInfo.unitPrice.toFixed(2)} SAR <span style="font-size: 0.95rem; text-decoration: line-through; color: var(--text-muted); font-weight: normal; margin-right: 0.5rem;">${regularPrice.toFixed(2)} SAR</span> <div style="font-size:0.75rem; color:#34d399; margin-top:0.25rem;">🏷️ خصم ${Math.round(promoInfo.pct * 100)}% (وفّر ${saving.toFixed(2)} SAR)</div>`;
        } else if (promoInfo && promoInfo.type === 'bundle' && promoInfo.unitPrice < regularPrice) {
            // Bundle deal: show effective per-unit price with strikethrough
            modalPriceValue.innerHTML = `${promoInfo.unitPrice.toFixed(2)} SAR <span style="font-size: 0.95rem; text-decoration: line-through; color: var(--text-muted); font-weight: normal; margin-right: 0.5rem;">${regularPrice.toFixed(2)} SAR</span> <div style="font-size:0.75rem; color:#34d399; margin-top:0.25rem;">(سعر الحبة بالعرض)</div>`;
        } else if (promoInfo && promoInfo.type === 'delivery' && promoInfo.deliveryPrice < regularPrice) {
            // Delivery discount: show delivery price as main price with strikethrough
            const saving = regularPrice - promoInfo.deliveryPrice;
            modalPriceValue.innerHTML = `${promoInfo.deliveryPrice.toFixed(2)} SAR <span style="font-size: 0.95rem; text-decoration: line-through; color: var(--text-muted); font-weight: normal; margin-right: 0.5rem;">${regularPrice.toFixed(2)} SAR</span> <div style="font-size:0.78rem; color:#38bdf8; margin-top:0.3rem;">🚚 سعر التوصيل بالعرض (وفّر ${saving.toFixed(2)} SAR)</div>`;
        } else {
            modalPriceValue.textContent = `${regularPrice.toFixed(2)} SAR`;
        }

        // Store badge
        modalStoreBadge.textContent = item.store;
        modalStoreBadge.className = 'store-badge';
        if (item.store.includes('Nahdi'))        modalStoreBadge.classList.add('store-nahdi');
        else if (item.store.includes('Dawaa'))   modalStoreBadge.classList.add('store-dawaa');
        else if (item.store.includes('United'))  modalStoreBadge.classList.add('store-united');
        else if (item.store.includes('Moaz'))    modalStoreBadge.classList.add('store-moaz');
        else if (item.store.includes('PharmaBrand')) modalStoreBadge.classList.add('store-pharmabrand');

        // Offer
        if (item.offer) {
            modalOfferBadge.textContent = `🎁 ${item.offer}`;
            modalOfferBadge.classList.remove('hidden');
        } else {
            modalOfferBadge.classList.add('hidden');
        }

        // Equivalents Matching Section
        modalEquivalentsList.innerHTML = '';

        const storeConfigs = [
            { name: 'صيدلية النهدي', key: 'Nahdi Online', class: 'store-nahdi' },
            { name: 'صيدلية الدواء', key: 'Al-Dawaa', class: 'store-dawaa' },
            { name: 'المتحدة', key: 'United Pharmacy', class: 'store-united' },
            { name: 'صيدلية معاذ', key: 'Moaz Pharma', class: 'store-moaz' },
            { name: 'فارما براند', key: 'PharmaBrand', class: 'store-pharmabrand' }
        ];

        storeConfigs.forEach((config) => {
            // Skip the store of the current product
            if (item.store === config.key) return;

            const targets = allResults.filter(r => r.store === config.key);
            const equiv = findEquivalent(item, targets);

            const div = document.createElement('div');
            div.className = 'equivalent-row';

            if (equiv) {
                const eqRegPrice = parseFloat(equiv.price);
                const eqPromoInfo = getPromoInfo(eqRegPrice, equiv.offer);
                let displayPrice = eqRegPrice;
                let priceNote = '';

                if (eqPromoInfo && eqPromoInfo.type === 'bundle' && eqPromoInfo.unitPrice < eqRegPrice) {
                    displayPrice = eqPromoInfo.unitPrice;
                    priceNote = `<span style="font-size:0.7rem; color:#34d399;">(بالعرض)</span>`;
                } else if (eqPromoInfo && eqPromoInfo.type === 'delivery' && eqPromoInfo.deliveryPrice < eqRegPrice) {
                    priceNote = `<span style="font-size:0.7rem; color:#38bdf8;">🚚 ${eqPromoInfo.deliveryPrice.toFixed(2)} للتوصيل</span>`;
                }

                div.innerHTML = `
                    <span class="eq-store-name"><span class="store-badge ${config.class}">${config.name}</span></span>
                    <span class="eq-price">
                        ${displayPrice.toFixed(2)} SAR 
                        ${priceNote}
                    </span>
                    <a href="${equiv.link}" target="_blank" rel="noopener noreferrer" class="eq-link">عرض 🔗</a>
                `;
            } else {
                div.innerHTML = `
                    <span class="eq-store-name"><span class="store-badge ${config.class}">${config.name}</span></span>
                    <span class="eq-missing">غير متوفر في نتائج هذا البحث</span>
                `;
            }
            modalEquivalentsList.appendChild(div);
        });

        productModal.classList.add('open');
    }

    function closeModal() {
        productModal.classList.remove('open');
    }

    modalCloseBtn.addEventListener('click', closeModal);
    productModal.addEventListener('click', (e) => {
        if (e.target === productModal) closeModal();
    });

    // ── CHECKOUT MODAL LOGIC ────────────────────────────────────────────────
    function openCheckoutModal(storeName) {
        const nameMap = {
            'Nahdi Online': 'صيدلية النهدي',
            'Al-Dawaa': 'صيدلية الدواء',
            'United Pharmacy': 'المتحدة',
            'Moaz Pharma': 'صيدلية معاذ',
            'PharmaBrand': 'فارما براند'
        };
        checkoutStoreName.textContent = nameMap[storeName] || storeName;
        checkoutItemsList.innerHTML = '';
        
        const storeResults = sessionScrapedProducts.filter(r => r.store.includes(storeName.split(' ')[0]));
        const linksToOpen = [];

        basket.forEach(basketItem => {
            let equiv = null;
            const q = basketItem.quantity || 1;

            if (basketItem.store.includes(storeName.split(' ')[0])) {
                equiv = basketItem;
            } else {
                const customLink = customEquivalents[basketItem.link]?.[storeName];
                if (customLink) {
                    equiv = sessionScrapedProducts.find(p => p.link === customLink);
                }
                if (!equiv) {
                    equiv = findEquivalent(basketItem, storeResults);
                }
            }

            const row = document.createElement('div');
            row.className = 'checkout-item-row';

            if (equiv) {
                const regularPrice = parseFloat(equiv.price);
                const displayPrice = getEffectiveUnitPrice(regularPrice, equiv.offer) || regularPrice;
                const totalCost = displayPrice * q;
                
                row.innerHTML = `
                    <div class="checkout-item-info">
                        <div class="checkout-item-title" title="${equiv.name}">${equiv.name}</div>
                        <div class="checkout-item-price">${q} × ${displayPrice.toFixed(2)} SAR = ${totalCost.toFixed(2)} SAR</div>
                    </div>
                    <a href="${equiv.link}" target="_blank" rel="noopener noreferrer" class="checkout-item-link-btn">
                        شراء المنتج 🔗
                    </a>
                `;
                linksToOpen.push(equiv.link);
            } else {
                row.innerHTML = `
                    <div class="checkout-item-info">
                        <div class="checkout-item-title" style="color: var(--text-muted);" title="${basketItem.name}">${basketItem.name}</div>
                        <div class="checkout-item-price">${q} × نقص</div>
                    </div>
                    <span class="checkout-item-missing-badge">غير متوفر</span>
                `;
            }
            checkoutItemsList.appendChild(row);
        });

        // Set up "Open All" button
        checkoutOpenAllBtn.onclick = () => {
            if (linksToOpen.length === 0) return;
            let blocked = false;
            linksToOpen.forEach((link) => {
                const newTab = window.open(link, '_blank');
                if (!newTab) {
                    blocked = true;
                }
            });
            if (blocked) {
                alert('⚠️ تم حظر فتح بعض الروابط تلقائياً من قبل متصفحك. يرجى السماح بالنوافذ المنبثقة (Pop-ups) لهذا الموقع من شريط العنوان.');
            }
        };

        checkoutModal.classList.add('open');
    }

    function closeCheckoutModal() {
        checkoutModal.classList.remove('open');
    }

    checkoutCloseBtn.addEventListener('click', closeCheckoutModal);
    checkoutModal.addEventListener('click', (e) => {
        if (e.target === checkoutModal) closeCheckoutModal();
    });

    // Delegated click listener for checkout buttons in basket drawer
    basketDrawer.addEventListener('click', (e) => {
        const btn = e.target.closest('.checkout-store-btn');
        if (btn) {
            const storeName = btn.getAttribute('data-store');
            openCheckoutModal(storeName);
        }
    });
});
