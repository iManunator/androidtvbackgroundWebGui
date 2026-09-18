let lightboxImages = [], currentLightboxIndex = 0, loadedGalleryData = {}, currentGalleryTab = null, currentEditingFile = null;
let galleryCacheBuster = Date.now();

function openLightbox(layoutKey, index) {
    if (!loadedGalleryData || !loadedGalleryData[layoutKey]) return;
    
    lightboxImages = loadedGalleryData[layoutKey];
    currentLightboxIndex = index;
    
    document.getElementById('lightbox').style.display = 'flex';
    document.addEventListener('keydown', handleLightboxKeys);
    
    showLightboxImage(currentLightboxIndex);
}

function closeLightbox() {
    document.getElementById('lightbox').style.display = 'none';
    document.removeEventListener('keydown', handleLightboxKeys);
}

function showLightboxImage(index) {
    if (index < 0) index = lightboxImages.length - 1;
    if (index >= lightboxImages.length) index = 0;
    currentLightboxIndex = index;
    
    const layoutKey = Object.keys(loadedGalleryData).find(k => loadedGalleryData[k] === lightboxImages);
    const imgSrc = `/api/gallery/image/${encodeURIComponent(layoutKey)}/${encodeURIComponent(lightboxImages[index])}?t=${galleryCacheBuster}`;
    document.getElementById('lightbox-img').src = imgSrc;
    
    const editBtn = document.getElementById('lightbox-edit-btn');
    if (layoutKey && layoutKey.startsWith("LayoutPreview: ")) {
        editBtn.style.display = 'none';
    } else {
        editBtn.style.display = 'block';
        editBtn.onclick = () => editGalleryImage(layoutKey, lightboxImages[index]);
    }
}

function changeLightboxImage(direction) {
    showLightboxImage(currentLightboxIndex + direction);
}

function handleLightboxKeys(e) {
    if (e.key === 'ArrowRight') {
        changeLightboxImage(1);
    } else if (e.key === 'ArrowLeft') {
        changeLightboxImage(-1);
    } else if (e.key === 'Escape') {
        closeLightbox();
    }
}

function renderGalleryUI() {
    const container = document.getElementById('gallery-content');
    const folders = Object.keys(loadedGalleryData).filter(f => !f.startsWith("LayoutPreview: ")).sort();
    const images = loadedGalleryData[currentGalleryTab] || [];
    
    let tabsHtml = '<div class="sub-nav-tabs" style="overflow: hidden; justify-content: space-between; align-items: center;">';
    tabsHtml += '<div style="display: flex; gap: 10px; overflow-x: auto; scrollbar-width: thin; padding-bottom: 5px; flex: 1; margin-right: 10px;">';
    folders.forEach(folder => {
        const activeClass = folder === currentGalleryTab ? 'active' : '';
        const displayName = folder.replace('Layout: ', '');
        tabsHtml += `<div class="sub-tab-link ${activeClass}" onclick="switchGalleryTab('${folder}')">${displayName}</div>`;
    });
    tabsHtml += '</div>';
    
    tabsHtml += `<button onclick="scanForOrphans()" style="background: #ef6c00; width: auto; padding: 6px 12px; font-size: 12px; border: 1px solid #ff9800; white-space: nowrap; flex-shrink: 0; margin-right: 5px;" data-i18n="scan_btn">Find Unavailable Media</button>`;

    if (images.length > 0) {
        tabsHtml += `<button onclick="deleteAllGalleryImages('${currentGalleryTab}')" style="background: #c62828; width: auto; padding: 6px 12px; font-size: 12px; border: 1px solid #ff5252; white-space: nowrap; flex-shrink: 0;">🗑️ Delete All</button>`;
    }
    tabsHtml += '</div>';

    let imagesHtml = '<div class="gallery-grid">';
    
    if (images.length === 0) {
            imagesHtml += '<p style="grid-column: 1/-1; text-align:center; color:#666; margin-top: 20px;">No images in this folder.</p>';
    } else {
        images.forEach((img, index) => {
            const src = `/api/gallery/image/${encodeURIComponent(currentGalleryTab)}/${encodeURIComponent(img)}?t=${galleryCacheBuster}`;
            imagesHtml += `
                <div class="gallery-item">
                    <img src="${src}" loading="lazy" onclick="openLightbox('${currentGalleryTab}', ${index})">
                    <div class="caption">${img}</div>
                    <button onclick="editGalleryImage('${currentGalleryTab}', '${img}')" style="position:absolute; top:5px; right:5px; width:auto; padding:4px 8px; font-size:12px; background:rgba(0,0,0,0.7); border:1px solid #fff; cursor:pointer; color:white;">✏️</button>
                    <button onclick="deleteGalleryImage('${currentGalleryTab}', '${img}')" style="position:absolute; top:5px; left:5px; width:auto; padding:4px 8px; font-size:12px; background:rgba(198, 40, 40, 0.7); border:1px solid #fff; cursor:pointer; color:white;">🗑️</button>
                </div>`;
        });
    }
    imagesHtml += '</div>';
    
    container.innerHTML = tabsHtml + imagesHtml;
}

function switchGalleryTab(folder) {
    currentGalleryTab = folder;
    renderGalleryUI();
}

async function loadGallery() {
    const container = document.getElementById('gallery-content');
    
    try {
        const resp = await fetch('/api/gallery/list');
        const data = await resp.json();
        loadedGalleryData = data;
        const visibleFolders = Object.keys(data).filter(f => !f.startsWith("LayoutPreview: "));
        
        if (visibleFolders.length === 0) {
            container.innerHTML = '<p style="color:#888; text-align:center; margin-top:50px;">No generated images found.</p>';
            return;
        }

        // Default tab selection
        if (!currentGalleryTab || !data[currentGalleryTab] || currentGalleryTab.startsWith("LayoutPreview: ")) {
            const folders = visibleFolders.sort();
            if (data["Editor (Unsorted)"]) currentGalleryTab = "Editor (Unsorted)";
            else currentGalleryTab = folders[0];
        }

        renderGalleryUI();
    } catch (e) {
        console.error(e);
        container.innerHTML = '<p style="color:red; text-align:center;">Error loading gallery.</p>';
    }
}

function saveImage() { 
    const l = document.createElement('a'); 
    
    const overlay = canvas.getObjects().find(o => o.dataTag === 'guide_overlay');
    const wasVisible = overlay ? overlay.visible : false;
    if (overlay) overlay.visible = false;

    l.href = canvas.toDataURL({ format: 'jpeg', quality: 0.95 }); 
    
    if (overlay) overlay.visible = wasVisible;

    let fname = 'tv-background.jpg';
    if (lastFetchedData && lastFetchedData.title) {
        const safeTitle = lastFetchedData.title.replace(/[^a-z0-9\s\.\-_]/gi, '').trim();
        const parts = [safeTitle];
        if(lastFetchedData.year && lastFetchedData.year !== 'N/A') parts.push(lastFetchedData.year);
        if(lastFetchedData.imdb_id) parts.push(lastFetchedData.imdb_id);
        fname = parts.join(' - ') + '.jpg';
    }
    l.download = fname; 
    l.click(); 
}

async function saveToGallery() {
    // Clear editing state if saving as new
    currentEditingFile = null;
    document.getElementById('btn-save-changes').style.display = 'none';
    await saveToGalleryInternal(document.getElementById('layoutName').value || "Default");
    galleryCacheBuster = Date.now();
    alert("Image saved to Gallery!");
    loadGallery();
}

async function saveToGalleryInternal(layoutName, overwriteFilename = null, targetType = 'gallery', organizeByGenre = false, useSharedMetadata = false) {
    const overlay = canvas.getObjects().find(o => o.dataTag === 'guide_overlay');
    const wasVisible = overlay ? overlay.visible : false;
    if (overlay) overlay.visible = false;

    const dataURL = canvas.toDataURL({ format: 'jpeg', quality: 0.95 });
    
    if (overlay) overlay.visible = wasVisible;

    const json = (typeof safeCanvasToJSON === 'function')
        ? safeCanvasToJSON(['dataTag', 'fullMediaText', 'selectable', 'evented', 'lockScalingY', 'splitByGrapheme', 'fixedHeight', 'editable', 'matchHeight', 'autoBackgroundColor', 'textureId', 'textureScale', 'textureRotation', 'textureOpacity'])
        : canvas.toJSON(['dataTag', 'fullMediaText', 'selectable', 'evented', 'lockScalingY', 'splitByGrapheme', 'fixedHeight', 'editable', 'matchHeight', 'autoBackgroundColor', 'textureId', 'textureScale', 'textureRotation', 'textureOpacity']);
    
    const payload = { 
        image: dataURL, 
        layout_name: layoutName, 
        canvas_json: json, 
        overwrite_filename: overwriteFilename, 
        target_type: targetType,
        organize_by_genre: organizeByGenre
    };
    
    if (lastFetchedData) {
        if (typeof extractMetadata === 'function') {
            payload.metadata = extractMetadata(lastFetchedData);
        } else {
            // Fallback if extractMetadata is not available (e.g. standalone gallery page)
            payload.metadata = { 
                ...lastFetchedData,
                action_url: (lastFetchedData.source === 'Jellyfin' && lastFetchedData.id) ? "jellyfin://items/" + lastFetchedData.id : null,
            };
        }
    }
    const resp = await fetch('/api/save_image', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    return await resp.json();
}

async function editGalleryImage(folder, filename) {
    const resp = await fetch(`/api/gallery/data/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`);
    const data = await resp.json();
    
    if (data.status === 'error') {
        alert("Cannot edit this image (no layout data found). Only images generated with the new editor version can be edited.");
        return;
    }
    
    if (data.metadata) {
        lastFetchedData = data.metadata;
    }

    canvas.loadFromJSON(data, () => {
        canvas.getObjects().forEach(o => { if(o.dataTag === 'overview') o.set('objectCaching', false); });
        canvas.requestRenderAll();
        
        // Restore mainBg reference
        mainBg = canvas.getObjects().find(o => o.dataTag === 'background');
        // Fallback if not tagged
        if (!mainBg && canvas.getObjects().length > 0) {
            const firstObj = canvas.item(0);
            if (firstObj && firstObj.type === 'image' && firstObj.width > 500) {
                mainBg = firstObj;
                mainBg.set('dataTag', 'background');
            }
        }
        // Remove ghost effects
        const ghosts = canvas.getObjects().filter(o => o.dataTag === 'fade_effect' || o.dataTag === 'grid_line');
        ghosts.forEach(g => canvas.remove(g));

        // Restore UI settings from saved data
        if (data.custom_effects) {
            const eff = data.custom_effects;
            
            // Helper to finalize UI updates after BG is ready
            const finalizeEffects = () => {
                if (typeof updateFadeControls === 'function') updateFadeControls();
            };

            if (eff.backgroundMode) {
                backgroundMode = eff.backgroundMode;
                const bgModeSel = document.getElementById('bgStyleSelect');
                if(bgModeSel) bgModeSel.value = backgroundMode;
                if (typeof populateFadeEffectOptions === 'function') populateFadeEffectOptions(backgroundMode);
            }

            if(eff.bgColor) { 
                document.getElementById('bgColor').value = eff.bgColor; 
                canvas.setBackgroundColor(eff.bgColor, () => { finalizeEffects(); }); 
            }
            if(eff.bgBrightness) document.getElementById('bgBrightness').value = eff.bgBrightness;
            if(eff.fadeEffect) document.getElementById('fadeEffect').value = eff.fadeEffect;
            if(eff.fadeRadius) document.getElementById('fadeRadius').value = eff.fadeRadius;
            if(eff.fadeSoftness) {
                const el = document.getElementById('fadeSoftness');
                if(el) {
                    el.value = eff.fadeSoftness;
                    document.getElementById('fadeSoftnessVal').innerText = eff.fadeSoftness;
                }
            }
            if(eff.fadeLeft) document.getElementById('fadeLeft').value = eff.fadeLeft;
            if(eff.fadeRight) document.getElementById('fadeRight').value = eff.fadeRight;
            if(eff.fadeTop) document.getElementById('fadeTop').value = eff.fadeTop;
            if(eff.fadeBottom) document.getElementById('fadeBottom').value = eff.fadeBottom;
            if(eff.tagAlignment) document.getElementById('tagAlignSelect').value = eff.tagAlignment;
            else if(eff.centerTags !== undefined) document.getElementById('tagAlignSelect').value = eff.centerTags ? 'center' : 'left';
            if(eff.tagPadding) {
                const el = document.getElementById('tagPaddingInput');
                if(el) {
                    el.value = eff.tagPadding;
                    const valEl = document.getElementById('tagPaddingVal');
                    if(valEl) valEl.innerText = eff.tagPadding + "px";
                }
            }
            if(eff.lineSpacing) {
                const el = document.getElementById('lineSpacingInput');
                if(el) {
                    el.value = eff.lineSpacing;
                    const valEl = document.getElementById('lineSpacingVal');
                    if(valEl) valEl.innerText = eff.lineSpacing + "px";
                }
            }
            if(eff.textContentAlignment) document.getElementById('textContentAlignSelect').value = eff.textContentAlignment;
            if(eff.limitGenres !== undefined) {
                const val = eff.limitGenres ? 2 : 6;
                document.getElementById('genreLimitSlider').value = val;
                document.getElementById('genreLimitVal').innerText = (val == 6) ? "Max" : val;
            }
            if(eff.genreLimit !== undefined) {
                document.getElementById('genreLimitSlider').value = eff.genreLimit;
                document.getElementById('genreLimitVal').innerText = (eff.genreLimit == 6) ? "Max" : eff.genreLimit;
            }
            
            // If no bgColor was set, we must call finalize manually here, otherwise it happens in callback
            if (!eff.bgColor) finalizeEffects();
        } else {
            if (typeof updateFades === 'function') updateFades();
        }

        closeLightbox();
        openTab({currentTarget: document.querySelector('.tab-link')}, 'editor-tab');
        
        currentEditingFile = { folder: folder, filename: filename };
        
        // Toggle UI for Editing Mode
        document.getElementById('btn-save-changes').style.display = 'block';
        document.getElementById('btn-save-layout').style.display = 'none';
        document.getElementById('layoutNameContainer').style.display = 'none';

        // Lock UI
        document.querySelectorAll('.tab-link').forEach(el => { el.style.pointerEvents = 'none'; el.style.opacity = '0.5'; });
        ['btn-shuffle', 'btn-save-gallery', 'btn-save-layout', 'btn-load-layout', 'btn-start-batch'].forEach(id => {
            const btn = document.getElementById(id);
            if(btn) btn.disabled = true;
        });
        
        if (folder.startsWith("Layout: ")) {
            document.getElementById('layoutName').value = folder.replace("Layout: ", "");
        }
    });
}

async function saveEditedImage() {
    if (!currentEditingFile) return;
    
    const saveBtn = document.getElementById('btn-save-changes');
    const originalText = saveBtn.innerText;
    saveBtn.disabled = true;
    saveBtn.innerText = "Saving...";

    const layoutName = document.getElementById('layoutName').value || "Default";
    let overwrite = currentEditingFile.filename;
    
    await saveToGalleryInternal(layoutName, overwrite);
    galleryCacheBuster = Date.now();
    
    if (currentEditingFile.folder) {
        currentGalleryTab = currentEditingFile.folder;
    }
    await loadGallery();

    // Unlock UI
    document.querySelectorAll('.tab-link').forEach(el => { el.style.pointerEvents = 'auto'; el.style.opacity = '1'; });
    ['btn-shuffle', 'btn-save-gallery', 'btn-save-layout', 'btn-load-layout', 'btn-start-batch'].forEach(id => {
        const btn = document.getElementById(id);
        if(btn) btn.disabled = false;
    });
    
    const galleryTabBtn = document.querySelector(".tab-link[onclick*='gallery-tab']");
    if (galleryTabBtn && typeof openTab === 'function') {
        openTab({currentTarget: galleryTabBtn}, 'gallery-tab');
    }
    
    currentEditingFile = null;
    saveBtn.style.display = 'none';
    document.getElementById('btn-save-layout').style.display = 'block';
    document.getElementById('layoutNameContainer').style.display = 'block';
    saveBtn.disabled = false;
    saveBtn.innerText = originalText;
}

async function deleteAllGalleryImages(folder) {
    if (!confirm(`⚠️ DANGER ⚠️\n\nAre you sure you want to delete ALL images in "${folder}"?\n\nThis action cannot be undone!`)) {
        return;
    }
    
    const resp = await fetch('/api/gallery/delete_all', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ folder: folder })
    });
    
    if (resp.ok) {
        loadGallery();
    } else {
        const err = await resp.json();
        alert("Error: " + (err.message || "Unknown error"));
    }
}

async function deleteGalleryImage(folder, filename) {
    if (!confirm(`Delete image "${filename}"?`)) return;
    
    const resp = await fetch('/api/gallery/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ folder: folder, filename: filename })
    });
    
    if (resp.ok) {
        loadGallery();
    } else {
        const err = await resp.json();
        alert("Error: " + (err.message || "Unknown error"));
    }
}

async function loadLayoutsList() {
    const container = document.getElementById('layouts-content');
    const resp = await fetch('/api/layouts/list');
    const layouts = await resp.json();
    
    const galResp = await fetch('/api/gallery/list');
    loadedGalleryData = await galResp.json();

    let html = '';
    layouts.forEach(l => {
        const key = `LayoutPreview: ${l}`;
        let previews = '';
        const safeLabel = String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const nameEnc = encodeURIComponent(l);
        
        // Layout Thumbnail URL (with timestamp to force refresh)
        const thumbSrc = `/api/layouts/preview/${encodeURIComponent(l)}?t=${new Date().getTime()}`;

        if (loadedGalleryData[key]) {
            loadedGalleryData[key].slice(0, 10).forEach((img, index) => {
                const src = `/api/gallery/image/${encodeURIComponent(key)}/${encodeURIComponent(img)}?t=${galleryCacheBuster}`;
                previews += `<img src="${src}" onclick="openLightbox(${JSON.stringify(key)}, ${index})">`;
            });
        } else { previews = '<span style="font-size:11px; color:#666;">No generated images yet.</span>'; }

        html += `<div class="layout-card">
            <div class="layout-header">
                <div style="display:flex; align-items:center; gap:10px;">
                    <img src="${thumbSrc}" style="height:40px; width:71px; object-fit:cover; border-radius:4px; border:1px solid #555;" onerror="this.style.display='none'">
                    <h3 style="margin:0; color:#fff; font-size:16px;">${safeLabel}</h3>
                </div>
                <div>
                    <button data-layout-enc="${nameEnc}" onclick="loadLayout(decodeURIComponent(this.dataset.layoutEnc))" style="width:auto; padding:5px 15px; font-size:12px;">📂 Load</button>
                    <button data-layout-enc="${nameEnc}" onclick="deleteLayout(decodeURIComponent(this.dataset.layoutEnc))" style="width:auto; padding:5px 15px; font-size:12px; background-color: #c62828; margin-left: 5px;">🗑️ Delete</button>
                </div>
            </div>
            <div class="layout-previews">${previews}</div>
        </div>`;
    });
    container.innerHTML = html || '<p style="text-align:center; color:#666;">No saved layouts.</p>';
}

async function deleteLayout(name) {
    if (!confirm(`Are you sure you want to delete the layout "${name}"? Generated images in the gallery will be kept.`)) {
        return;
    }
    const resp = await fetch(`/api/layouts/delete/${encodeURIComponent(name)}`, { method: 'POST' });
    let result = {};
    try { result = await resp.json(); } catch (e) {}
    if (resp.ok) {
        loadLayoutsList();
        loadGallery();
    } else {
        alert(result.message || "Error deleting layout.");
    }
}

// Updated Scan Logic: Uses Media IDs from JSON files instead of Filenames
async function scanForOrphans() {
    if (!currentGalleryTab || currentGalleryTab.startsWith("LayoutPreview: ")) {
        alert("Please select a valid layout folder first.");
        return;
    }
    
    const btn = document.querySelector('button[onclick="scanForOrphans()"]');
    const originalText = btn.innerText;
    btn.innerText = "Scanning...";
    btn.disabled = true;

    try {
        // 1. Fetch Provider Items (Source of Truth)
        // We fetch Movies and Series from all providers
        const providers = 'jellyfin,plex,trakt,sonarr,radarr';
        const providerRes = await fetch(`/api/media/list?mode=library&types=Movie,Series&limit=0&providers=${providers}`);
        const providerData = await providerRes.json();
        
        if (providerData.error) throw new Error(providerData.error);

        // Safety check: If no items returned, abort to prevent accidental "delete all"
        if (!Array.isArray(providerData) || providerData.length === 0) {
            throw new Error("No media items found from providers. Check your provider settings or connections.");
        }
        
        // Create a set of valid IDs from Provider
        const validIds = new Set();
        providerData.forEach(item => {
            if (item.Id) validIds.add(String(item.Id));
        });
        
        console.log(`[Scan] Provider items: ${providerData.length}, Valid IDs: ${validIds.size}`);

        // 2. Fetch Local Gallery Items
        const galleryImages = loadedGalleryData[currentGalleryTab] || [];
        const jsonFiles = galleryImages.filter(f => f.endsWith('.json'));

        const orphans = [];
        
        // 3. Check each JSON file for valid ID
        // Process in chunks to avoid blocking the browser
        const chunkSize = 10;
        for (let i = 0; i < jsonFiles.length; i += chunkSize) {
            const chunk = jsonFiles.slice(i, i + chunkSize);
            btn.innerText = `Scanning ${Math.min(i + chunkSize, jsonFiles.length)}/${jsonFiles.length}...`;
            
            await Promise.all(chunk.map(async (jsonFile) => {
                try {
                    // Fetch the JSON content
                    const fileUrl = `/api/gallery/image/${encodeURIComponent(currentGalleryTab)}/${encodeURIComponent(jsonFile)}?t=${Date.now()}`;
                    const res = await fetch(fileUrl);
                    if (!res.ok) return;
                    
                    const data = await res.json();
                    let itemId = null;
                    
                    // Extract ID from metadata (Jellyfin/Emby style in action_url)
                    if (data.metadata) {
                        if (data.metadata.action_url) {
                            // Matches "jellyfin://items/ID"
                            const match = data.metadata.action_url.match(/items\/([a-zA-Z0-9]+)/);
                            if (match) itemId = match[1];
                        }
                        // Fallback: direct ID if available
                        if (!itemId && data.metadata.id) itemId = data.metadata.id;
                    }
                    
                    // If we found an ID, check if it exists in provider list
                    if (itemId && !validIds.has(String(itemId))) {
                        // ID not found -> Orphan
                        const baseName = jsonFile.replace('.json', '');
                        orphans.push(jsonFile);
                        
                        // Add associated images if they exist
                        const jpg = baseName + '.jpg';
                        if (galleryImages.includes(jpg)) orphans.push(jpg);
                        
                        const ambi = baseName + '.ambilight.jpg';
                        if (galleryImages.includes(ambi)) orphans.push(ambi);
                    }
                } catch (err) {
                    console.warn(`[Scan] Failed to check ${jsonFile}`, err);
                }
            }));
        }
        
        // Deduplicate list
        const uniqueOrphans = [...new Set(orphans)];

        if (uniqueOrphans.length === 0) {
            alert("No unavailable media found.");
        } else {
            showOrphanModal(uniqueOrphans);
        }
    } catch (e) {
        console.error(e);
        alert("Scan failed: " + e.message);
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

function showOrphanModal(orphans) {
    const list = document.getElementById('orphanList');
    list.innerHTML = '';
    orphans.forEach(file => {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; align-items:center; padding:2px;';
        div.innerHTML = `<input type="checkbox" class="orphan-check" value="${file}" checked style="margin-right:10px;"> <span style="font-size:12px; color:#ccc;">${file}</span>`;
        list.appendChild(div);
    });
    document.getElementById('orphanModal').style.display = 'flex';
}

function toggleOrphanSelection(checked) {
    document.querySelectorAll('.orphan-check').forEach(cb => cb.checked = checked);
}

async function deleteSelectedOrphans() {
    const selected = Array.from(document.querySelectorAll('.orphan-check:checked')).map(cb => cb.value);
    if (selected.length === 0) return;
    
    if (!confirm(`Delete ${selected.length} files?`)) return;
    
    const layoutKey = currentGalleryTab;
    document.getElementById('orphanModal').style.display = 'none';
    
    for (const file of selected) {
        await fetch('/api/gallery/delete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ folder: layoutKey, filename: file })
        });
    }
    
    loadGallery();
}
