let batchTimer = null;

function toggleBatchInputs() {
    const mode = document.getElementById('batchMode').value;
    const filterMode = document.getElementById('batchFilterMode').value;

    document.getElementById('batchRandomSettings').style.display = (mode === 'random') ? 'block' : 'none';
    document.getElementById('batchFilterSettings').style.display = (mode === 'library' || mode === 'trending') ? 'block' : 'none';

    // Filter Inputs
    document.getElementById('filterInputYear').style.display = (mode === 'library' && filterMode === 'year') ? 'block' : 'none';
    document.getElementById('filterInputGenre').style.display = (mode === 'library' && filterMode === 'genre') ? 'block' : 'none';
    document.getElementById('filterInputRating').style.display = (mode === 'library' && (filterMode === 'rating' || filterMode === 'imdb')) ? 'block' : 'none';
    document.getElementById('filterInputOfficialRating').style.display = (mode === 'library' && filterMode === 'official_rating') ? 'block' : 'none';
    document.getElementById('filterInputCustom').style.display = (mode === 'library' && filterMode === 'custom') ? 'block' : 'none';
    // Note: 'missing' mode requires no extra inputs, so it falls through to 'none' for all specific inputs above.

    // Update label for count based on context
    const countLabel = document.querySelector('label[for="batchCount"]');
    if (mode === 'library') countLabel.innerText = "Limit (Max Images)";
    else countLabel.innerText = "Number of Images";

    // Auto-Run Visibility
    document.getElementById('autoRunSettings').style.display = document.getElementById('batchAutoRun').checked ? 'block' : 'none';
}

// Ensure Cron UI handles the new option correctly
function toggleCronInputs() {
    const modeEl = document.getElementById('cronSourceMode');
    const filterEl = document.getElementById('cronFilterMode');
    
    if (!modeEl || !filterEl) return;

    const mode = modeEl.value;
    const filterMode = filterEl.value;

    // Hide generic filter value input if "missing" is selected
    const valInput = document.getElementById('cronFilterValue');
    if (valInput) {
        // If mode is library AND filter is missing, hide the value input
        if (mode === 'library' && filterMode === 'missing') {
            valInput.style.display = 'none';
        } else if (mode === 'library' && filterMode !== 'all' && !['available','not_available','requestable'].includes(filterMode)) {
            valInput.style.display = 'block';
        } else {
            valInput.style.display = 'none';
        }
    }
    const seerrOpts = document.getElementById('cronSeerrOptions');
    if (seerrOpts) {
        seerrOpts.style.display = (mode === 'trending' || filterMode === 'available' || filterMode === 'not_available' || filterMode === 'requestable') ? 'block' : 'none';
    }
}

// Inject "Missing / Wanted" option if it doesn't exist
function injectMissingFilterOption() {
    const targets = ['batchFilterMode', 'cronFilterMode'];
    targets.forEach(id => {
        const select = document.getElementById(id);
        if (select && !select.querySelector('option[value="missing"]')) {
            const opt = document.createElement('option');
            opt.value = 'missing';
            opt.innerText = 'Missing / Wanted (Radarr/Sonarr)';
            select.appendChild(opt);
        }
        if (select && !select.querySelector('option[value="requestable"]')) {
            [
                ['available', 'Seerr: Available'],
                ['not_available', 'Seerr: Not in library'],
                ['requestable', 'Seerr: Requestable']
            ].forEach(([v, t]) => {
                const o = document.createElement('option');
                o.value = v;
                o.innerText = t;
                select.appendChild(o);
            });
        }
    });
}

async function loadBatchLayouts() {
    const select = document.getElementById('batchLayoutSelect');
    const resp = await fetch('/api/layouts/list');
    const layouts = await resp.json();
    select.innerHTML = '';
    layouts.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l;
        opt.innerText = l;
        select.appendChild(opt);
    });
    // Select current layout if possible
    const current = document.getElementById('layoutName').value;
    if (layouts.includes(current)) select.value = current;
}

function logBatch(msg) {
    const log = document.getElementById('batchLog');
    const time = new Date().toLocaleTimeString();

    // Smart Auto-Scroll: Only scroll if user is near bottom (50px tolerance)
    const isAtBottom = log.scrollHeight - log.scrollTop <= log.clientHeight + 50;

    const line = document.createElement('div');
    line.innerText = `[${time}] ${msg}`;
    log.appendChild(line);

    if (isAtBottom) log.scrollTop = log.scrollHeight;
}

function stopBatchProcess() {
    isBatchRunning = false;
    if (batchTimer) clearTimeout(batchTimer);
    logBatch("Stopping batch process...");
    document.getElementById('btn-start-batch').style.display = 'block';
    document.getElementById('btn-stop-batch').style.display = 'none';
    if (typeof setUIInteraction === 'function') setUIInteraction(true);
}

async function startBatchProcess() {
    if (isBatchRunning) return;
    if (batchTimer) clearTimeout(batchTimer);
    isBatchRunning = true;

    const layoutName = document.getElementById('batchLayoutSelect').value;
    const mode = document.getElementById('batchMode').value;
    const filterMode = document.getElementById('batchFilterMode').value;
    const count = parseInt(document.getElementById('batchCount').value);
    const delay = 1500; // Fixed generous delay for stability
    const overwrite = document.getElementById('batchOverwrite').checked;
    const cleanup = document.getElementById('batchCleanup') ? document.getElementById('batchCleanup').checked : false;
    const sortGenre = false;
    const dryRun = document.getElementById('batchDryRun').checked;

    document.getElementById('btn-start-batch').style.display = 'none';
    document.getElementById('btn-stop-batch').style.display = 'block';

    const logDiv = document.getElementById('batchLog');
    if (logDiv) {
        logDiv.innerText = "";
        logDiv.style.overflowY = 'auto';
    }

    if (typeof setUIInteraction === 'function') {
        setUIInteraction(false);
        document.getElementById('btn-stop-batch').disabled = false;
    }

    logBatch(`Starting batch for layout: "${layoutName}"`);

    if (dryRun) {
        logBatch(`[DRY RUN] Mode active. No images will be generated.`);
    }
    if (cleanup && mode === 'library') {
        logBatch(`[CLEANUP] Enabled. Missing files will be removed from library.`);
    }

    let itemsToProcess = [];
    if (mode === 'library' || mode === 'trending') {
        let mediaType = document.getElementById('batchMediaType').value || 'Movie,Series';
        let limitVal = document.getElementById('batchMaxItems').value || '0';

        let selectedProviders = Array.from(document.querySelectorAll('input[name="batchProvider"]:checked')).map(cb => cb.value);
        if (mode === 'trending') {
            if (!selectedProviders.includes('jellyseerr') && !selectedProviders.includes('seerr')) {
                selectedProviders = ['jellyseerr'];
            }
            filterMode = ['available', 'not_available', 'requestable'].includes(filterMode) ? filterMode : 'trending';
        }

        let qs = `?mode=${encodeURIComponent(mode === 'trending' ? 'trending' : filterMode)}&types=${encodeURIComponent(mediaType)}&limit=${encodeURIComponent(limitVal)}&providers=${encodeURIComponent(selectedProviders.join(','))}`;

        if (mode === 'trending') {
            qs += `&seerr_availability=${encodeURIComponent(['available','not_available','requestable'].includes(document.getElementById('batchFilterMode').value) ? document.getElementById('batchFilterMode').value : 'all')}`;
            qs += `&seerr_time_window=week`;
        }

        if (filterMode === 'year') qs += `&val=${encodeURIComponent(document.getElementById('batchFilterYear').value)}`;
        if (filterMode === 'genre') qs += `&val=${encodeURIComponent(document.getElementById('batchFilterGenre').value)}`;
        if (filterMode === 'rating') qs += `&val=${encodeURIComponent(document.getElementById('batchFilterRating').value)}`;
        if (filterMode === 'official_rating') qs += `&val=${encodeURIComponent(document.getElementById('batchFilterOfficialRating').value)}`;
        if (filterMode === 'custom') {
            qs += `&min_year=${encodeURIComponent(document.getElementById('batchFilterMinYear').value)}`;
            qs += `&max_year=${encodeURIComponent(document.getElementById('batchFilterMaxYear').value)}`;
            qs += `&min_rating=${encodeURIComponent(document.getElementById('batchFilterMinRating').value)}`;
            qs += `&genre=${encodeURIComponent(document.getElementById('batchFilterCustomGenre').value)}`;
        }

        logBatch(`Fetching ${mode} list (Filter: ${filterMode})...`);
        const resp = await fetch('/api/media/list' + qs);
        const list = await resp.json();
        if (list.error) { logBatch("Error: " + list.error); stopBatchProcess(); return; }

        itemsToProcess = list.map(i => ({ id: i.Id, name: i.Name }));
        logBatch(`Found ${itemsToProcess.length} matching items.`);

        if (itemsToProcess.length === 0) {
            logBatch("No items found. Stopping.");
            stopBatchProcess();
            return;
        }

        // --- CLIENT-SIDE CLEANUP LOGIC ---
        if (cleanup) {
            logBatch("Performing cleanup (ID-based)...");
            try {
                // 1. Get valid IDs from the list we just fetched
                const validIds = new Set(itemsToProcess.map(i => String(i.id)));
                
                // 2. Get existing files in the target layout
                const galleryRes = await fetch(`/api/gallery/list/${encodeURIComponent(layoutName)}`);
                const galleryFiles = await galleryRes.json();
                const jsonFiles = galleryFiles.filter(f => f.endsWith('.json'));

                let deletedCount = 0;

                // 3. Check each file
                for (const jsonFile of jsonFiles) {
                    try {
                        const fileUrl = `/api/gallery/image/${encodeURIComponent(layoutName)}/${encodeURIComponent(jsonFile)}?t=${Date.now()}`;
                        const res = await fetch(fileUrl);
                        if (!res.ok) continue;
                        const data = await res.json();
                        
                        // Extract ID
                        let itemId = data.metadata ? data.metadata.id : null;
                        
                        // If file has an ID, but it's not in our valid list -> Delete
                        if (itemId && !validIds.has(String(itemId))) {
                            const baseName = jsonFile.replace('.json', '');
                            await fetch('/api/gallery/delete', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ folder: layoutName, filename: baseName + '.jpg' }) // Delete API handles related files
                            });
                            deletedCount++;
                        }
                    } catch (e) { console.warn("Cleanup check failed for", jsonFile); }
                }
                logBatch(`Cleanup complete. Removed ${deletedCount} unavailable items.`);
            } catch (e) {
                logBatch("Cleanup failed: " + e.message);
            }
        }
    } else {
        logBatch(`Target: ${count} random images`);
        itemsToProcess = Array(count).fill(null);
    }

    // 1. Load the selected layout first
    if (!dryRun) {
        logBatch(`DEBUG: Calling loadLayout for "${layoutName}"...`);
        await loadLayout(layoutName, true);
    }
    logBatch("Layout loaded successfully.");

    // --- FIX: Capture initial layout state ---
    let initialState = null;
    if (!dryRun && typeof canvas !== 'undefined') {
        logBatch("DEBUG: Capturing initial state...");
        initialState = canvas.toJSON(['dataTag', 'fullMediaText', 'selectable', 'evented', 'lockScalingY', 'splitByGrapheme', 'fixedHeight', 'editable', 'matchHeight', 'autoBackgroundColor', 'textureId', 'textureScale', 'textureRotation', 'textureOpacity', 'snapToObjects', 'logoAutoFix', 'maxItems', 'fullList', 'slotWidth', 'slotHeight']);
        // Filter out ambilight background to prevent stacking
        if (initialState.objects) {
            initialState.objects = initialState.objects.filter(o => o.dataTag !== 'ambilight_bg');
        }
        logBatch("DEBUG: Initial state captured.");
    }



    const total = itemsToProcess.length;
    for (let i = 0; i < total; i++) {
        if (!isBatchRunning) break;

        const progress = Math.round(((i) / total) * 100);
        document.getElementById('batchProgressBar').style.width = `${progress}%`;
        document.getElementById('batchProgressBar').innerText = `${progress}%`;

        const item = itemsToProcess[i];
        const label = item ? item.name : `Random #${i + 1}`;

        if (dryRun) {
            logBatch(`[Dry Run] Would process: ${label}`);
            await new Promise(r => setTimeout(r, 50)); // Tiny delay for visual effect
            continue;
        }

        logBatch(`Processing (${i + 1}/${total}): ${label}`);

        // --- FIX: Restore initial layout state ---
        // Resets object positions (e.g. Overview) to prevent layout shifts from persisting
        if (!dryRun && initialState) {
            await new Promise(resolve => {
                canvas.loadFromJSON(initialState, () => {
                    mainBg = canvas.getObjects().find(o => o.dataTag === 'background');
                    resolve();
                });
            });
        }

        // Ensure Ambilight is removed before generating new image
        if (!dryRun && typeof canvas !== 'undefined') {
            const ambilightObjs = canvas.getObjects().filter(o => o.dataTag === 'ambilight_bg');
            ambilightObjs.forEach(o => canvas.remove(o));
        }

        // 1. Load data and update canvas text
        // (fetchMediaData comes from editor.js and handles the data fetching)
        await fetchMediaData(item ? item.id : null);

        // --- FIX: Correct Layout (Fixes overflow issues) ---
        // Since the text content has changed, widths have changed.
        // We must manually trigger a layout recalculation before saving.
        if (typeof canvas !== 'undefined') {

            // A. Recalculate Textboxes (e.g. Overview) to fit container
            canvas.getObjects().forEach(obj => {
                if (obj.dataTag === 'overview' && obj.type === 'textbox') {
                    if (typeof fitTextToContainer === 'function') {
                        fitTextToContainer(obj);
                    }
                }
                // Invalidate cache to prevent artifacts
                obj.setCoords();
                obj.dirty = true;
            });

            // B. CRITICAL: Re-align right-aligned tags
            // This pulls tags back to the left if they grew wider.
            if (typeof updateVerticalLayout === 'function') {
                await updateVerticalLayout();
            }

            // C. Force a clean redraw
            canvas.renderAll();
            logBatch("DEBUG: Canvas layout updated.");
        }

        // --- FIX END ---

        // 2. Hide overlay for screenshot
        const overlay = canvas.getObjects().find(o => o.dataTag === 'guide_overlay');
        const wasVisible = overlay ? overlay.visible : false;
        if (overlay) overlay.visible = false;

        const dataURL = canvas.toDataURL({ format: 'jpeg', quality: 0.95 });
        if (overlay) overlay.visible = wasVisible;

        // --- New: Separate Ambilight Data ---
        let ambilightDataURL = null;
        const ambilightObj = canvas.getObjects().find(o => o.dataTag === 'ambilight_bg');

        if (ambilightObj) {
            await new Promise(resolve => {
                const timer = setTimeout(() => {
                    logBatch("Warning: Ambilight clone operation timed out.");
                    resolve();
                }, 3000);

                const tempCanvas = new fabric.StaticCanvas(null, {
                    width: ambilightObj.getScaledWidth(),
                    height: ambilightObj.getScaledHeight()
                });

                ambilightObj.clone(function (cloned) {
                    clearTimeout(timer);
                    if (!cloned) {
                        logBatch("Warning: Failed to clone ambilight object.");
                        tempCanvas.dispose();
                        return resolve();
                    }
                    cloned.set({
                        left: tempCanvas.width / 2,
                        top: tempCanvas.height / 2,
                        originX: 'center',
                        originY: 'center'
                    });
                    tempCanvas.add(cloned);
                    tempCanvas.renderAll();
                    ambilightDataURL = tempCanvas.toDataURL({ format: 'jpeg', quality: 0.8 });

                    tempCanvas.dispose();
                    resolve();
                });
            });
            canvas.remove(ambilightObj);
        }
        // --- End New ---

        const json = canvas.toJSON(['dataTag', 'fullMediaText', 'selectable', 'evented', 'lockScalingY', 'splitByGrapheme', 'fixedHeight', 'editable', 'matchHeight', 'autoBackgroundColor', 'textureId', 'textureScale', 'textureRotation', 'textureOpacity', 'maxItems', 'fullList', 'slotWidth', 'slotHeight']);

        // Inject custom_effects so the saved JSON contains overlay info & blocked areas
        json.custom_effects = {
            bgColor: document.getElementById('bgColor').value,
            bgBrightness: document.getElementById('bgBrightness').value,
            fadeEffect: document.getElementById('fadeEffect').value,
            fadeRadius: document.getElementById('fadeRadius').value,
            fadeSoftness: document.getElementById('fadeSoftness') ? document.getElementById('fadeSoftness').value : 40,
            fadeLeft: document.getElementById('fadeLeft').value,
            fadeRight: document.getElementById('fadeRight').value,
            fadeTop: document.getElementById('fadeTop').value,
            fadeBottom: document.getElementById('fadeBottom').value,
            tagAlignment: document.getElementById('tagAlignSelect').value,
            tagPadding: document.getElementById('tagPaddingInput') ? document.getElementById('tagPaddingInput').value : 20,
            lineSpacing: document.getElementById('lineSpacingInput') ? document.getElementById('lineSpacingInput').value : 20,
            tagSeparator: document.getElementById('tagSeparatorInput') ? document.getElementById('tagSeparatorInput').value : '',
            tagSeparatorSize: document.getElementById('tagSeparatorSizeInput') ? document.getElementById('tagSeparatorSizeInput').value : 30,
            tagSeparatorColor: document.getElementById('tagSeparatorColorInput') ? document.getElementById('tagSeparatorColorInput').value : '#ffffff',
            tagSeparatorTexture: document.getElementById('tagSeparatorTextureSelect') ? document.getElementById('tagSeparatorTextureSelect').value : '',
            tagSeparatorOpacity: document.getElementById('tagSeparatorOpacityInput') ? document.getElementById('tagSeparatorOpacityInput').value : 100,
            rowSeparatorStyle: document.getElementById('rowSeparatorStyle') ? document.getElementById('rowSeparatorStyle').value : '',
            rowSeparatorThickness: document.getElementById('rowSeparatorThickness') ? document.getElementById('rowSeparatorThickness').value : 2,
            rowSeparatorColor: document.getElementById('rowSeparatorColor') ? document.getElementById('rowSeparatorColor').value : '#ffffff',
            rowSeparatorTexture: document.getElementById('rowSeparatorTextureSelect') ? document.getElementById('rowSeparatorTextureSelect').value : '',
            rowSeparatorOpacity: document.getElementById('rowSeparatorOpacityInput') ? document.getElementById('rowSeparatorOpacityInput').value : 100,
            rowSeparatorAlign: document.getElementById('rowSeparatorAlign') ? document.getElementById('rowSeparatorAlign').value : 'center',
            rowSeparatorAutoWidth: document.getElementById('rowSeparatorAutoWidth') ? document.getElementById('rowSeparatorAutoWidth').checked : true,
            rowSeparatorWidth: document.getElementById('rowSeparatorWidth') ? document.getElementById('rowSeparatorWidth').value : 500,
            textContentAlignment: document.getElementById('textContentAlignSelect').value,
            genreLimit: document.getElementById('genreLimitSlider').value,
            overlayId: document.getElementById('overlaySelect').value,
            margins: {
                top: document.getElementById('marginTopInput').value,
                bottom: document.getElementById('marginBottomInput').value,
                left: document.getElementById('marginLeftInput').value,
                right: document.getElementById('marginRightInput').value
            },
            logoAutoFix: document.getElementById('batchLogoAutoFix') ? document.getElementById('batchLogoAutoFix').checked : true,
            backgroundMode: backgroundMode
        };

        if (json.custom_effects.overlayId && typeof overlayProfiles !== 'undefined') {
            const profile = overlayProfiles.find(p => p.id === json.custom_effects.overlayId);
            if (profile && profile.blocked_areas) {
                json.custom_effects.blocked_areas = profile.blocked_areas;
            }
        }

        let metadata = {};
        if (typeof extractMetadata === 'function' && lastFetchedData) {
            metadata = extractMetadata(lastFetchedData);
        }

        const payload = {
            image: dataURL,
            layout_name: layoutName,
            canvas_json: json,
            overwrite_filename: null,
            target_type: 'gallery',
            organize_by_genre: sortGenre,
            metadata: metadata,
            ambilight_image_data: ambilightDataURL // Add to payload
        };



        await fetch('/api/save_image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Update preview image in batch tab
        document.getElementById('batchPreviewImg').src = dataURL;

        if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }

    document.getElementById('batchProgressBar').style.width = `100%`;
    document.getElementById('batchProgressBar').innerText = `100%`;
    logBatch("Batch processing finished!");

    loadGallery();

    // Auto-Run Logic
    if (document.getElementById('batchAutoRun').checked) {
        const interval = parseInt(document.getElementById('batchInterval').value) || 60;
        logBatch(`Auto-Run enabled. Waiting ${interval} minutes for next run...`);
        // Do NOT call stopBatchProcess() here to keep the "Stop" button active
        batchTimer = setTimeout(startBatchProcess, interval * 60 * 1000);
    } else {
        stopBatchProcess();
    }
}

// Initialize UI additions
document.addEventListener('DOMContentLoaded', () => {
    injectMissingFilterOption();
    // Re-run toggle to ensure UI state is correct after injection
    if(typeof toggleBatchInputs === 'function') toggleBatchInputs();
    if(typeof toggleCronInputs === 'function') toggleCronInputs();
});
