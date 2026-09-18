// --- MOBILE NAVIGATION ---
function toggleTopNav() {
    const navContainer = document.querySelector('.nav-links-container');
    if (navContainer) {
        navContainer.classList.toggle('open');
    }
}

function openTab(evt, tabName) {
    var i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("tab-content");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
    }
    tablinks = document.getElementsByClassName("tab-link");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].className = tablinks[i].className.replace(" active", "");
    }
    document.getElementById(tabName).style.display = "flex";
    if (evt.currentTarget) {
        evt.currentTarget.className += " active";
        const mobileTitle = document.getElementById('mobile-header-title');
        if (mobileTitle) mobileTitle.innerText = evt.currentTarget.innerText;
    }

    // Close mobile nav if open
    const navContainer = document.querySelector('.nav-links-container');
    if (navContainer && navContainer.classList.contains('open')) {
        navContainer.classList.remove('open');
    }

    // Close floating property panel if open
    const propPanel = document.getElementById('propertyPanel');
    if (propPanel) {
        propPanel.style.display = 'none';
    }

    localStorage.setItem('active_tab', tabName);
}


// --- GLOBAL FIXES ---
// Helper: Extracts all font families directly from the JSON data structure
function extractFontsFromJSON(data) {
    const fonts = new Set();

    const traverse = (objects) => {
        if (!objects) return;
        objects.forEach(obj => {
            if (obj.fontFamily) {
                fonts.add(obj.fontFamily);
            }
            // Check inside groups recursively
            if (obj.objects) {
                traverse(obj.objects);
            }
        });
    };

    if (data.objects) traverse(data.objects);
    return Array.from(fonts);
}
(function () {
    const originalSetter = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'textBaseline').set;
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'textBaseline', {
        set: function (value) {
            if (value === 'alphabetical') value = 'alphabetic';
            return originalSetter.call(this, value);
        },
        configurable: true
    });

    // Patch Textbox to render background covering padding
    fabric.Textbox.prototype._renderBackground = function (ctx) {
        if (!this.backgroundColor) return;
        var dim = this._getNonTransformedDimensions();
        ctx.fillStyle = this.backgroundColor;
        const pad = this.padding || 0;
        ctx.fillRect(
            -dim.x / 2 - pad - 10,
            -dim.y / 2 - pad,
            dim.x + pad * 2 + 20,
            dim.y + pad * 2
        );
        this._removeShadow(ctx);
    };

    // Patch IText to render background with same buffer
    fabric.IText.prototype._renderBackground = function (ctx) {
        if (!this.backgroundColor) return;
        var dim = this._getNonTransformedDimensions();
        ctx.fillStyle = this.backgroundColor;
        const pad = this.padding || 0;
        ctx.fillRect(
            -dim.x / 2 - pad - 10,
            -dim.y / 2 - pad,
            dim.x + pad * 2 + 20,
            dim.y + pad * 2
        );
        this._removeShadow(ctx);
    };

    // Patch Image to render background covering padding
    fabric.Image.prototype._renderBackground = function (ctx) {
        if (!this.backgroundColor) return;
        var dim = this._getNonTransformedDimensions();
        ctx.fillStyle = this.backgroundColor;
        const pad = this.padding || 0;
        ctx.fillRect(
            -dim.x / 2 - pad,
            -dim.y / 2 - pad,
            dim.x + pad * 2,
            dim.y + pad * 2
        );
        this._removeShadow(ctx);
    };
})();

let canvas, mainBg = null;
let ambilightBg = null, backgroundMode = 'solid'; // 'solid' | 'ambilight'
let lastValidBgState = null;
let fades = { left: null, right: null, top: null, bottom: null, corner: null };
let resizeRaf = null, lastFetchedData = null, layoutDebounceTimer = null, previewDebounceTimer = null;
let preferredLogoWidth = null;
let overlayProfiles = [];
let overlayCanvasFabric = null;
let currentEditingOverlayId = null;
let activeBlockedAreas = []; // Active blocked areas for layout
let textureProfiles = [];
let separatorTextureImg = null; // Global for separator texture
let rowSeparatorTextureImg = null; // Global for row separator texture
let gridEnabled = false, movingObjects = [], snapLines = { v: [], h: [] }, guideLines = [], isBatchRunning = false;
const gridSize = 50;
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

let undoStack = [];
let redoStack = [];
let isUndoRedoProcessing = false;
let autosaveTimer = null;
const MAX_HISTORY = 10;

const FADE_OPTIONS = {
    solid: [
        { value: 'custom', text: 'Custom (Linear)' },
        { value: 'bottom-left', text: 'Bottom-Left Corner' },
        { value: 'bottom-right', text: 'Bottom-Right Corner' },
        { value: 'top-left', text: 'Top-Left Corner' },
        { value: 'top-right', text: 'Top-Right Corner' },
        { value: 'vignette', text: 'Vignette' }
    ],
    ambilight: [
        { value: 'mask', text: 'Smooth Alpha Mask' },
        { value: 'soft_round', text: 'Gaussian Blurred Mask' },
        { value: 'gradient', text: 'Linear Erasers' },
        { value: 'vignette', text: 'Elliptical Vignette' }
    ]
};

function toggleMobileMenu() {
    document.body.classList.toggle('mobile-menu-open');
}

function toggleGroup(id) {
    // Accordion behavior: Close other batch groups when opening one
    const batchGroups = ['group-batch-settings', 'group-cron-jobs'];
    if (batchGroups.includes(id)) {
        batchGroups.forEach(otherId => {
            if (otherId !== id) {
                const otherGroup = document.getElementById(otherId);
                if (otherGroup) {
                    const otherContent = otherGroup.querySelector('.group-content');
                    const otherArrow = otherGroup.querySelector('.group-arrow');
                    if (otherContent) otherContent.classList.add('collapsed');
                    if (otherArrow) otherArrow.classList.add('collapsed');
                    saveSidebarState(otherId, true);
                }
            }
        });
    }

    const group = document.getElementById(id);
    if (!group) return;
    const content = group.querySelector('.group-content');
    const arrow = group.querySelector('.group-arrow');

    content.classList.toggle('collapsed');
    if (arrow) arrow.classList.toggle('collapsed');

    saveSidebarState(id, content.classList.contains('collapsed'));
}

function expandGroup(id) {
    const group = document.getElementById(id);
    if (!group) return;
    const content = group.querySelector('.group-content');
    const arrow = group.querySelector('.group-arrow');
    content.classList.remove('collapsed');
    if (arrow) arrow.classList.remove('collapsed');

    saveSidebarState(id, false);
}

function saveSidebarState(id, isCollapsed) {
    const states = JSON.parse(localStorage.getItem('sidebar_groups') || '{}');
    states[id] = isCollapsed;
    localStorage.setItem('sidebar_groups', JSON.stringify(states));
}

function toggleBatchGroup(id) {
    // Alias to toggleGroup to ensure consistent behavior
    toggleGroup(id);
}

function restoreSidebarState() {
    const states = JSON.parse(localStorage.getItem('sidebar_groups') || '{}');
    Object.keys(states).forEach(id => {
        const group = document.getElementById(id);
        if (group) {
            const content = group.querySelector('.group-content');
            const arrow = group.querySelector('.group-arrow');
            if (states[id]) {
                content.classList.add('collapsed');
                if (arrow) arrow.classList.add('collapsed');
            } else {
                content.classList.remove('collapsed');
                if (arrow) arrow.classList.remove('collapsed');
            }
        }
    });
}

function updateSelectionUI(e) {
    const activeObj = canvas.getActiveObject();
    const textPanel = document.getElementById('group-text');
    const iconPanel = document.getElementById('icon-properties');
    const logoSettings = document.getElementById('logoSettings');
    const alignControl = document.getElementById('textAlignControl');
    const bgControl = document.getElementById('textBackgroundControl');
    const genreControl = document.getElementById('genreLimitControl');

    // Hide all initially
    if (textPanel) textPanel.style.display = 'none';
    if (iconPanel) iconPanel.style.display = 'none';
    if (logoSettings) logoSettings.style.display = 'none';

    // Toggle Layer Controls
    const layerContainer = document.getElementById('layerControlContainer');
    if (layerContainer) {
        layerContainer.style.display = (activeObj && activeObj !== mainBg) ? 'flex' : 'none';
    }

    if (!activeObj) return;

    // Enforce Aspect Ratio & Resize Handles
    if (activeObj.dataTag === 'overview') {
        // Overview: Allow free resizing (side handles enabled)
        activeObj.setControlsVisibility({ mt: true, mb: true, ml: true, mr: true, bl: true, br: true, tl: true, tr: true, mtr: true });
        activeObj.lockUniScaling = false;
        activeObj.borderColor = 'rgba(102, 153, 255, 0.75)'; // Standard Blue
        activeObj.cornerColor = 'rgba(102, 153, 255, 0.5)';
    } else {
        // Others: Lock aspect ratio (hide side handles)
        activeObj.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false, bl: true, br: true, tl: true, tr: true, mtr: true });
        activeObj.lockUniScaling = true;
        activeObj.borderColor = 'rgba(255, 165, 0, 0.75)'; // Orange to indicate locked aspect
        activeObj.cornerColor = 'rgba(255, 165, 0, 0.5)';
    }

    // Visual indicator for disabled snapping
    if (activeObj.snapToObjects === false) {
        activeObj.borderColor = 'rgba(255, 50, 50, 0.8)'; // Red
        activeObj.cornerColor = 'rgba(255, 50, 50, 0.6)';
    }

    if (activeObj === mainBg) {
        expandGroup('group-canvas');
    } else if (activeObj && (activeObj.type === 'image' && (activeObj.dataTag === 'icon' || activeObj.dataTag === 'certification' || activeObj.dataTag === 'title'))) {
        expandGroup('group-logos');
    }

    // Sync Snap Checkboxes
    const snapText = document.getElementById('snapToggleText');
    const snapIcon = document.getElementById('snapToggleIcon');
    const isSnapEnabled = activeObj ? (activeObj.snapToObjects !== false) : true;
    if (snapText) snapText.checked = isSnapEnabled;
    if (snapIcon) snapIcon.checked = isSnapEnabled;

    const resetSnapText = document.getElementById('resetSnapText');
    const resetSnapIcon = document.getElementById('resetSnapIcon');
    if (resetSnapText) resetSnapText.style.display = isSnapEnabled ? 'none' : 'block';
    if (resetSnapIcon) resetSnapIcon.style.display = isSnapEnabled ? 'none' : 'block';

    if (activeObj.type === 'image' && (activeObj.dataTag === 'icon' || activeObj.dataTag === 'certification' || activeObj.dataTag === 'title')) {
        if (iconPanel) {
            iconPanel.style.display = 'block';
            document.getElementById('iconSizeInput').value = Math.round(activeObj.getScaledHeight());
            const isMatchHeight = activeObj.matchHeight || false;
            document.getElementById('matchHeightToggle').checked = isMatchHeight;
            document.getElementById('iconSizeInput').disabled = isMatchHeight;
        }
        if (logoSettings) {
            logoSettings.style.display = 'block';
            const autoFix = document.getElementById('logoAutoFixToggle');
            if (autoFix) autoFix.checked = activeObj.logoAutoFix !== false;

            const bright = document.getElementById('logoBrightnessInput');
            if (bright) {
                const f = (activeObj.filters || []).find(x => x.type === 'Brightness');
                bright.value = f ? (f.brightness * 100) : 0;
                const valDisplay = document.getElementById('logoBrightnessVal');
                if (valDisplay) valDisplay.innerText = bright.value + "%";
            }

            const col = document.getElementById('logoColorInput');
            const blend = (activeObj.filters || []).find(x => x.type === 'BlendColor');
            if (col) col.value = blend ? blend.color : (activeObj.tint || "#ffffff");

            // Hide "Use Text Title" if this is not the title tag
            const useTextBtn = document.querySelector('button[data-i18n="use_text_title"]');
            if (useTextBtn) {
                useTextBtn.style.display = (activeObj.dataTag === 'title') ? 'block' : 'none';
            }
        }
    } else if (activeObj.type === 'i-text' || activeObj.type === 'textbox' || (activeObj.type === 'group' && (activeObj.dataTag === 'rating_star' || activeObj.dataTag === 'rating' || activeObj.dataTag === 'provider_source' || activeObj.dataTag === 'omdb_rotten_tomatoes' || activeObj.dataTag === 'omdb_metacritic')) || activeObj.dataTag === 'title') {
        if (textPanel) {
            textPanel.style.display = 'block';
            expandGroup('group-text');
        }

        let textObj = activeObj;
        if (activeObj.type === 'group') textObj = activeObj.getObjects().find(o => o.type === 'i-text');

        // Show "Use Logo" button only if it is a title and we have a logo url
        const useLogoBtn = document.getElementById('btn-use-logo');
        if (useLogoBtn) {
            useLogoBtn.style.display = (activeObj.dataTag === 'title' && lastFetchedData && lastFetchedData.logo_url) ? 'block' : 'none';
        }

        // Show "Switch Logo" button for RT tags
        const switchLogoBtn = document.getElementById('btn-switch-logo');
        if (switchLogoBtn) {
            switchLogoBtn.style.display = (activeObj.dataTag === 'omdb_rotten_tomatoes') ? 'block' : 'none';
        }

        if (textObj) {
            document.getElementById('fontSizeInput').value = textObj.fontSize;
            document.getElementById('fontFamilySelect').value = textObj.fontFamily;

            // Populate Stroke
            document.getElementById('textStrokeColor').value = textObj.stroke || "#000000";
            document.getElementById('textStrokeWidth').value = textObj.strokeWidth || 0;

            // Populate Shadow
            if (textObj.shadow) {
                document.getElementById('shadowColor').value = textObj.shadow.color || "#000000";
                document.getElementById('shadowBlur').value = textObj.shadow.blur || 0;
                document.getElementById('shadowOffsetX').value = textObj.shadow.offsetX || 0;
                document.getElementById('shadowOffsetY').value = textObj.shadow.offsetY || 0;
            } else {
                document.getElementById('shadowColor').value = "#000000";
                document.getElementById('shadowBlur').value = 0;
                document.getElementById('shadowOffsetX').value = 0;
                document.getElementById('shadowOffsetY').value = 0;
            }

            // Max Items Slider Logic (Actors/Directors)
            if (activeObj.dataTag === 'actors' || activeObj.dataTag === 'directors') {
                document.getElementById('maxItemsGroup').style.display = 'flex';
                const currentMax = activeObj.maxItems || (activeObj.dataTag === 'directors' ? 3 : 5);
                document.getElementById('maxItemsSlider').value = currentMax;
                document.getElementById('maxItemsVal').innerText = currentMax;

                // Also update Floating Menu Slider
                const propGroup = document.getElementById('prop-max-items-group');
                if (propGroup) {
                    propGroup.style.display = 'block';
                    document.getElementById('prop-max-items').value = currentMax;
                    document.getElementById('prop-max-items-val').innerText = currentMax;
                }
            } else {
                document.getElementById('maxItemsGroup').style.display = 'none';
                const propGroup = document.getElementById('prop-max-items-group');
                if (propGroup) propGroup.style.display = 'none';
            }

            // Check fill type (Pattern vs Color)
            const isPattern = (textObj.fill && typeof textObj.fill === 'object' && textObj.fill.source);
            document.getElementById('fillTypeTexture').checked = isPattern;
            document.getElementById('fillTypeColor').checked = !isPattern;

            document.getElementById('fillColorContainer').style.display = isPattern ? 'none' : 'block';
            document.getElementById('fillTextureContainer').style.display = isPattern ? 'block' : 'none';

            if (!isPattern && typeof textObj.fill === 'string') {
                const color = new fabric.Color(textObj.fill);
                document.getElementById('fontColorInput').value = "#" + color.toHex();
            } else if (isPattern) {
                if (textObj.textureId) document.getElementById('textureSelect').value = textObj.textureId;
                if (textObj.textureScale) {
                    document.getElementById('textureScale').value = textObj.textureScale;
                    document.getElementById('textureScaleVal').innerText = textObj.textureScale + "x";
                } else {
                    document.getElementById('textureScale').value = 1;
                    document.getElementById('textureScaleVal').innerText = "1x";
                }
                if (textObj.textureRotation) {
                    document.getElementById('textureRotation').value = textObj.textureRotation;
                    document.getElementById('textureRotationVal').innerText = textObj.textureRotation + "°";
                } else {
                    document.getElementById('textureRotation').value = 0;
                    document.getElementById('textureRotationVal').innerText = "0°";
                }
                if (textObj.textureOpacity !== undefined) {
                    document.getElementById('textureOpacity').value = textObj.textureOpacity * 100;
                    document.getElementById('textureOpacityVal').innerText = Math.round(textObj.textureOpacity * 100) + "%";
                } else {
                    document.getElementById('textureOpacity').value = 100;
                    document.getElementById('textureOpacityVal').innerText = "100%";
                }
            }
        }

        if (activeObj.type === 'textbox') {
            alignControl.style.display = 'block';
        } else {
            alignControl.style.display = 'none';
        }

        if (bgControl) {
            if (activeObj.type === 'textbox' || activeObj.type === 'i-text' || activeObj.type === 'image') {
                bgControl.style.display = 'block';
                const hasBg = !!activeObj.backgroundColor;
                document.getElementById('textBgEnable').checked = hasBg;
                document.getElementById('textBgSettings').style.display = hasBg ? 'block' : 'none';

                if (hasBg) {
                    const c = new fabric.Color(activeObj.backgroundColor);
                    const source = c.getSource();
                    const isAuto = activeObj.autoBackgroundColor || false;
                    document.getElementById('textBgAuto').checked = isAuto;
                    document.getElementById('textBgColor').disabled = isAuto;

                    if (source) {
                        const hex = "#" + ((1 << 24) + (source[0] << 16) + (source[1] << 8) + source[2]).toString(16).slice(1);
                        document.getElementById('textBgColor').value = hex;
                        const opacity = Math.round(source[3] * 100);
                        document.getElementById('textBgOpacity').value = opacity;
                        document.getElementById('textBgOpacityVal').innerText = opacity + "%";
                    }
                }
            } else {
                bgControl.style.display = 'none';
            }
        }

        if (genreControl) {
            genreControl.style.display = (activeObj.dataTag === 'genres') ? 'block' : 'none';
        }
    }
}

function updateSelectedFontSize() {
    const activeObj = canvas.getActiveObject();
    if (activeObj) {
        const newSize = parseInt(document.getElementById('fontSizeInput').value);
        let textObj = (activeObj.type === 'group') ? activeObj.getObjects().find(o => o.type === 'i-text') : activeObj;
        if (textObj) {
            textObj.set("fontSize", newSize);
            if (activeObj.type === 'group') {
                if (activeObj.dataTag === 'rating_star' || activeObj.dataTag === 'rating') {
                    const imgObj = activeObj.getObjects().find(o => o.type === 'image');
                    if (imgObj) {
                        imgObj.scaleToHeight(newSize);
                        textObj.set('left', imgObj.left + imgObj.getScaledWidth() + 10);
                        textObj.set('top', imgObj.top + (imgObj.getScaledHeight() - textObj.getScaledHeight()) / 2);
                    }
                } else if (activeObj.dataTag === 'provider_source') {
                    const imgObj = activeObj.getObjects().find(o => o.type === 'image');
                    if (imgObj) {
                        // Scale Logo relative to Text Height (1.5x)
                        const targetH = textObj.height * textObj.scaleY; // Text height varies with font size
                        // Note: 'fontSize' property change on IText affects dimensions.
                        // But we need to ensure the logo scales proportionally.
                        // The original logic was img.scaleToHeight(targetH * 1.5).
                        // Here we assume textObj has updated dimensions.
                        // Force update of text dimensions
                        textObj.setCoords();
                        const currentTextHeight = textObj.getScaledHeight();
                        imgObj.scaleToHeight(currentTextHeight * 1.2); // Matching render_task logic (1.2) - editor had 1.5, adjusting to match
                        // Reposition Logo
                        imgObj.set({ left: textObj.getScaledWidth() + 15 });
                    }
                } else if (activeObj.dataTag === 'omdb_rotten_tomatoes' || activeObj.dataTag === 'omdb_metacritic') {
                    const imgObj = activeObj.getObjects().find(o => o.type === 'image');
                    if (imgObj) {
                        textObj.setCoords();
                        const currentTextHeight = textObj.getScaledHeight();
                        imgObj.scaleToHeight(currentTextHeight * 1.0);
                        imgObj.set({ left: 0, top: 0 });
                        textObj.set({ left: imgObj.getScaledWidth() + 15, top: 0 });
                    }
                }
                activeObj.addWithUpdate();
            }
            else activeObj.setCoords();
            updateVerticalLayout();
            canvas.requestRenderAll();
            saveToLocalStorage();
        }
    }
}

function updateIconSize() {
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'image') {
        const newSize = parseInt(document.getElementById('iconSizeInput').value);
        activeObj.scaleToHeight(newSize);
        activeObj.setCoords();
        updateVerticalLayout();
        canvas.requestRenderAll();
        saveToLocalStorage();
    }
}

function updateSelectedFontFamily() {
    const activeObj = canvas.getActiveObject();
    if (activeObj) {
        let textObj = (activeObj.type === 'group') ? activeObj.getObjects().find(o => o.type === 'i-text') : activeObj;
        if (textObj) {
            const fontName = document.getElementById('fontFamilySelect').value;
            document.fonts.load(`10px "${fontName}"`).then(() => {
                textObj.set("fontFamily", fontName);
                if (textObj.type === 'i-text') textObj.set("text", textObj.text);
                if (activeObj.type === 'group') {
                    if (activeObj.dataTag === 'rating_star' || activeObj.dataTag === 'rating') {
                        canvas.renderAll(); // Force dimension update for text
                        const imgObj = activeObj.getObjects().find(o => o.type === 'image');
                        if (imgObj && textObj) {
                            textObj.set('top', imgObj.top + (imgObj.getScaledHeight() - textObj.getScaledHeight()) / 2);
                        }
                    } else if (activeObj.dataTag === 'provider_source') {
                        canvas.renderAll(); // Force dimension update for text
                        const imgObj = activeObj.getObjects().find(o => o.type === 'image');
                        if (imgObj && textObj) {
                            // Re-layout: Text at 0, Logo after text
                            // Reset text position relative to group 0
                            textObj.set({ left: 0, originX: 'left' });

                            // Rescale Logo to match new font metrics
                            const targetH = textObj.getScaledHeight();
                            imgObj.scaleToHeight(targetH * 1.2);

                            // Position logo after text with padding
                            imgObj.set({ left: textObj.getScaledWidth() + 15, originX: 'left' });
                        }
                    }
                    activeObj.addWithUpdate();
                }
                else activeObj.setCoords();
                canvas.renderAll(); // Force dimension update before layout
                updateVerticalLayout();
                canvas.requestRenderAll();
                saveToLocalStorage();
            });
        }
    }
}

function applyFontToAll() {
    const fontName = document.getElementById('fontFamilySelect').value;
    const fontColor = document.getElementById('fontColorInput').value;
    if (!canvas) return;
    document.fonts.load(`10px "${fontName}"`).then(() => {
        canvas.getObjects().forEach(obj => {
            if (obj.dataTag === 'overview') return;
            if (obj.type === 'i-text' || obj.type === 'textbox') {
                obj.set("fontFamily", fontName);
                obj.set("fill", fontColor);
                if (obj.type === 'i-text') obj.set("text", obj.text);
                obj.setCoords();
            } else if (obj.type === 'group') {
                const textObj = obj.getObjects().find(o => o.type === 'i-text');
                if (textObj) {
                    textObj.set("fontFamily", fontName);
                    textObj.set("fill", fontColor);

                    if (obj.dataTag === 'omdb_rotten_tomatoes' || obj.dataTag === 'omdb_metacritic') {
                        const imgObj = obj.getObjects().find(o => o.type === 'image');
                        if (imgObj) {
                            textObj.setCoords();
                            const currentTextHeight = textObj.getScaledHeight();
                            imgObj.scaleToHeight(currentTextHeight * 1.0);
                            imgObj.set({ left: 0, top: 0 });
                            textObj.set({ left: imgObj.getScaledWidth() + 15, top: 0 });
                        }
                    }

                    obj.addWithUpdate();
                }
            }
        });
        canvas.renderAll(); // Force dimension update before layout
        updateVerticalLayout();
        canvas.requestRenderAll();
        saveToLocalStorage();
    });
}

function applyFontSizeToAll() {
    const newSize = parseInt(document.getElementById('fontSizeInput').value);
    if (!canvas || isNaN(newSize)) return;

    canvas.getObjects().forEach(obj => {
        // Exclude overview and title/logo
        if (obj.dataTag === 'overview' || obj.dataTag === 'title') return;

        let textObj = (obj.type === 'group') ? obj.getObjects().find(o => o.type === 'i-text') : obj;

        if (textObj && (obj.type === 'i-text' || obj.type === 'textbox' || obj.type === 'group')) {
            textObj.set("fontSize", newSize);

            if (obj.type === 'group') {
                if (obj.dataTag === 'rating_star' || obj.dataTag === 'rating') {
                    const imgObj = obj.getObjects().find(o => o.type === 'image');
                    if (imgObj) {
                        imgObj.scaleToHeight(newSize);
                        textObj.set('left', imgObj.left + imgObj.getScaledWidth() + 10);
                        textObj.set('top', imgObj.top + (imgObj.getScaledHeight() - textObj.getScaledHeight()) / 2);
                    }
                } else if (obj.dataTag === 'omdb_rotten_tomatoes' || obj.dataTag === 'omdb_metacritic') {
                    const imgObj = obj.getObjects().find(o => o.type === 'image');
                    if (imgObj) {
                        textObj.setCoords();
                        const currentTextHeight = textObj.getScaledHeight();
                        imgObj.scaleToHeight(currentTextHeight * 1.0);
                        imgObj.set({ left: 0, top: 0 });
                        textObj.set({ left: imgObj.getScaledWidth() + 15, top: 0 });
                    }
                }
                obj.addWithUpdate();
            } else {
                obj.setCoords();
            }
        }
    });

    updateVerticalLayout();
    canvas.requestRenderAll();
    saveToLocalStorage();
}

function setTextAlignment(align) {
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'textbox') {
        activeObj.set('textAlign', align);
        canvas.requestRenderAll();
        saveToLocalStorage();
    }
}

function updateTagPadding() {
    const val = document.getElementById('tagPaddingInput').value;
    document.getElementById('tagPaddingVal').innerText = val + "px";
    updateVerticalLayout();
    saveToLocalStorage();
}

function updateLineSpacing() {
    const val = document.getElementById('lineSpacingInput').value;
    document.getElementById('lineSpacingVal').innerText = val + "px";
    updateVerticalLayout();
    saveToLocalStorage();
}

function toggleMatchHeight() {
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'image') {
        activeObj.matchHeight = document.getElementById('matchHeightToggle').checked;
        document.getElementById('iconSizeInput').disabled = activeObj.matchHeight;
        if (document.getElementById('ribbonIconSize')) document.getElementById('ribbonIconSize').disabled = activeObj.matchHeight;
        if (document.getElementById('floatIconSize')) document.getElementById('floatIconSize').disabled = activeObj.matchHeight;

        updateVerticalLayout();
        canvas.requestRenderAll();
        saveToLocalStorage();
    }
}

function toggleObjectSnapping(type) {
    const activeObj = canvas.getActiveObject();
    if (activeObj) {
        let checkbox;
        if (type === 'text') checkbox = document.getElementById('snapToggleText');
        else if (type === 'icon') checkbox = document.getElementById('snapToggleIcon');

        if (checkbox) activeObj.snapToObjects = checkbox.checked;

        // Force layout update if snapping is re-enabled to snap tag back to grid
        if (activeObj.snapToObjects) {
            updateVerticalLayout();
        }

        updateSelectionUI();
        canvas.requestRenderAll();
        saveToLocalStorage();
    }
}

function resetSnap(type) {
    const activeObj = canvas.getActiveObject();
    if (activeObj) {
        activeObj.snapToObjects = true;
        updateVerticalLayout();
        updateSelectionUI();
        canvas.requestRenderAll();
        saveToLocalStorage();
    }
}

function moveLayer(direction) {
    const activeObj = canvas.getActiveObject();
    if (!activeObj) return;

    if (direction === 'up') canvas.bringForward(activeObj);
    else canvas.sendBackwards(activeObj);

    enforceLayering();
    canvas.requestRenderAll();
    saveToLocalStorage();
}

function updateTextStroke() {
    const activeObj = canvas.getActiveObject();
    if (activeObj) {
        let textObj = (activeObj.type === 'group') ? activeObj.getObjects().find(o => o.type === 'i-text') : activeObj;
        if (textObj && (textObj.type === 'i-text' || textObj.type === 'textbox')) {
            textObj.set('stroke', document.getElementById('textStrokeColor').value);
            textObj.set('strokeWidth', parseFloat(document.getElementById('textStrokeWidth').value));
            if (activeObj.type === 'group') activeObj.addWithUpdate();
            canvas.requestRenderAll();
            saveToLocalStorage();
        }
    }
}

function updateTextShadow() {
    const activeObj = canvas.getActiveObject();
    if (activeObj) {
        let textObj = (activeObj.type === 'group') ? activeObj.getObjects().find(o => o.type === 'i-text') : activeObj;
        if (textObj && (textObj.type === 'i-text' || textObj.type === 'textbox')) {
            const color = document.getElementById('shadowColor').value;
            const blur = parseInt(document.getElementById('shadowBlur').value);
            const offsetX = parseInt(document.getElementById('shadowOffsetX').value);
            const offsetY = parseInt(document.getElementById('shadowOffsetY').value);

            if (blur === 0 && offsetX === 0 && offsetY === 0) {
                textObj.set('shadow', null);
            } else {
                textObj.set('shadow', new fabric.Shadow({ color, blur, offsetX, offsetY }));
            }
            if (activeObj.type === 'group') activeObj.addWithUpdate();
            canvas.requestRenderAll();
            saveToLocalStorage();
        }
    }
}

function resetTextShadow() {
    document.getElementById('shadowBlur').value = 0;
    document.getElementById('shadowOffsetX').value = 0;
    document.getElementById('shadowOffsetY').value = 0;
    updateTextShadow();
}

function toggleTextBackground() {
    const activeObj = canvas.getActiveObject();
    if (activeObj && (activeObj.type === 'textbox' || activeObj.type === 'image' || activeObj.type === 'i-text')) {
        const enabled = document.getElementById('textBgEnable').checked;
        document.getElementById('textBgSettings').style.display = enabled ? 'block' : 'none';
        if (enabled) {
            activeObj.set('padding', 20);
            activeObj.setCoords();
            if (!activeObj.backgroundColor) {
                document.getElementById('textBgAuto').checked = true;
                document.getElementById('textBgOpacity').value = 50;
            }
            updateTextBackgroundSettings();
        } else {
            activeObj.set('backgroundColor', '');
            activeObj.set('padding', 0);
            activeObj.setCoords();
            activeObj.autoBackgroundColor = false;
            canvas.requestRenderAll();
            saveToLocalStorage();
        }
    }
}

function updateTextBackgroundSettings() {
    const activeObj = canvas.getActiveObject();
    if (!activeObj || (activeObj.type !== 'textbox' && activeObj.type !== 'image' && activeObj.type !== 'i-text')) return;

    const isAuto = document.getElementById('textBgAuto').checked;
    const opacity = parseInt(document.getElementById('textBgOpacity').value) / 100;
    document.getElementById('textBgOpacityVal').innerText = Math.round(opacity * 100) + "%";
    document.getElementById('textBgColor').disabled = isAuto;
    activeObj.autoBackgroundColor = isAuto;

    let r, g, b;
    if (isAuto) {
        const rgb = new fabric.Color(document.getElementById('bgColor').value).getSource();
        r = rgb[0]; g = rgb[1]; b = rgb[2];
        document.getElementById('textBgColor').value = "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    } else {
        const hex = document.getElementById('textBgColor').value;
        r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16);
    }
    activeObj.set('backgroundColor', `rgba(${r}, ${g}, ${b}, ${opacity})`);
    canvas.requestRenderAll();
    saveToLocalStorage();
}

function updateSelectedColor() {
    const activeObj = canvas.getActiveObject();
    if (activeObj) {
        let textObj = (activeObj.type === 'group') ? activeObj.getObjects().find(o => o.type === 'i-text') : activeObj;
        if (textObj) {
            textObj.set("fill", document.getElementById('fontColorInput').value);
            if (activeObj.type === 'group') activeObj.addWithUpdate();
            canvas.renderAll();
        }
    }
}

function fitTextToContainer(textbox) {
    if (!canvas || !textbox) return;
    const textSource = textbox.fullMediaText || textbox.text || "";

    // Performance: Disable auto-render during calculation
    const oldState = canvas.renderOnAddRemove;
    canvas.renderOnAddRemove = false;

    // 1. Maximize Space: Tight line height
    textbox.set('lineHeight', 1.1);

    // 2. Reset to full text to measure
    textbox.set('text', textSource);
    textbox.initDimensions();

    // 3. Calculate limit (Safety padding 5px)
    const limit = (textbox.fixedHeight || textbox.height) - 5;

    // 4. Aggressive Fitting (Truncation)
    if (textbox.height > limit) {
        let words = textSource.split(' ');

        // Optimization: Jump start if way too big
        if (textbox.height > limit * 1.5) {
            const ratio = limit / textbox.height;
            words = words.slice(0, Math.floor(words.length * ratio));
            textbox.set('text', words.join(' ') + '...');
            textbox.initDimensions();
        }

        while (textbox.height > limit && words.length > 0) { words.pop(); textbox.set('text', words.join(' ') + '...'); textbox.initDimensions(); }
    }
    canvas.renderOnAddRemove = oldState;
    canvas.requestRenderAll();
}

/**
 * Trims the width of a Textbox to match its longest rendered line,
 * clamping it to a maximum width.
 */
function shrinkTextboxToContent(textbox, maxWidth) {
    if (!textbox || textbox.type !== 'textbox' || !textbox._textLines) return;

    let maxLineW = 0;
    for (let i = 0; i < textbox._textLines.length; i++) {
        const w = textbox.getLineWidth(i);
        if (w > maxLineW) maxLineW = w;
    }

    if (maxLineW > 0) {
        // Use a small buffer to prevent accidental wrapping
        textbox.set('width', Math.min(maxLineW + 10, maxWidth));
        textbox.setCoords();
    }
}

function extractMetadata(item) {
    if (!item) return {};

    let actionUrl = null;
    if (item.source === 'Jellyfin' && item.id) {
        actionUrl = "jellyfin://items/" + item.id;
    }

    return {
        title: item.title || item.Name,
        original_title: item.original_title || item.OriginalTitle,
        year: item.year || item.ProductionYear,
        officialRating: item.officialRating || item.OfficialRating, // age_rating
        communityRating: item.rating || item.CommunityRating, // community_rating
        genres: item.genres || (Array.isArray(item.Genres) ? item.Genres.join(', ') : ""),
        overview: item.overview || item.Overview,
        action_url: actionUrl,
        provider_ids: item.provider_ids || item.ProviderIds,
        studios: item.studios || item.Studios,
        actors: item.actors || (Array.isArray(item.People) ? item.People.filter(p => p.Type === 'Actor').map(p => p.Name) : []),
        directors: item.directors || (Array.isArray(item.People) ? item.People.filter(p => p.Type === 'Director').map(p => p.Name) : []),
        tags: item.tags || item.Tags,
        source: item.source
    };
}

async function searchMedia() {
    const query = document.getElementById('mediaSearchInput').value;
    if (!query) return;

    const btn = document.querySelector('button[onclick="searchMedia()"]');
    const originalText = btn.innerText;
    btn.innerText = "⏳";
    btn.disabled = true;

    try {
        const resp = await fetch(`/api/media/search?q=${encodeURIComponent(query)}`);
        const items = await resp.json();

        if (items.length === 0) {
            alert("No results found.");
        } else if (items.length === 1) {
            fetchMediaData(items[0].Id);
        } else {
            let msg = "Found multiple items:\n";
            items.forEach((item, index) => {
                msg += `${index + 1}. ${item.Name} (${item.ProductionYear || '?'})\n`;
            });
            msg += "\nEnter number to select:";
            const choice = prompt(msg, "1");
            if (choice) {
                const idx = parseInt(choice) - 1;
                if (items[idx]) fetchMediaData(items[idx].Id);
            }
        }
    } catch (e) {
        console.error(e);
        alert("Search failed");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function fetchRandomPreview() {
    await fetchMediaData(null);
}

async function fetchMediaData(itemId = null) {
    const btn = document.getElementById('btn-shuffle');
    const indicator = document.getElementById('source-indicator');

    btn.disabled = true;
    const originalText = btn.innerText;
    if (!isBatchRunning) btn.innerText = "⏳ Loading...";
    if (!isBatchRunning) indicator.innerText = "Fetching...";

    // Clear background and effects immediately to prevent persistence
    let bgState = null;
    if (canvas) {
        const existingBg = canvas.getObjects().find(o => o.dataTag === 'background');
        if (existingBg) {
            bgState = {
                left: existingBg.left,
                top: existingBg.top,
                scaleX: existingBg.scaleX,
                scaleY: existingBg.scaleY,
                flipX: existingBg.flipX,
                flipY: existingBg.flipY,
                width: existingBg.width,
                height: existingBg.height,
                originX: existingBg.originX,
                originY: existingBg.originY
            };
            lastValidBgState = bgState;
        }

        const bgObjects = canvas.getObjects().filter(o => o.dataTag === 'background');
        bgObjects.forEach(o => canvas.remove(o));
        if (mainBg && !bgObjects.includes(mainBg)) { canvas.remove(mainBg); }
        mainBg = null;
        if (canvas.backgroundImage) { canvas.setBackgroundImage(null, canvas.renderAll.bind(canvas)); }

        const effectObjects = canvas.getObjects().filter(o => o.dataTag === 'fade_effect' || o.dataTag === 'ambilight_bg');
        effectObjects.forEach(o => canvas.remove(o));
        if (ambilightBg) { canvas.remove(ambilightBg); ambilightBg = null; }

        canvas.requestRenderAll();
    }

    try {
        let url;
        if (itemId) {
            url = `/api/media/item/${itemId}`;
        } else {
            const providerEl = document.getElementById('shuffleProvider');
            const provider = (providerEl && providerEl.value) ? providerEl.value : 'jellyfin';
            try { localStorage.setItem('tvb_shuffle_provider', provider); } catch (e) {}
            url = `/api/media/random?provider=${encodeURIComponent(provider)}`;
        }
        const response = await fetch(url);
        const data = await response.json();
        if (data && data.error) {
            throw new Error(data.error);
        }

        // --- OMDb Integration ---
        if (data.imdb_id) {
            try {
                // Determine if we have a key in settings before trying
                // We can't easily check settings inputs here if not on settings tab, 
                // but fetchOmdbData handles checking the DOM input.
                // Issue: If user is on "Batch" tab, the Settings input might be empty if it wasn't populated?
                // The input values are in the DOM even if hidden.
                // But better to rely on config.omdb.api_key if DOM is empty? 
                // fetchOmdbData uses DOM element 'set-omdb-key'.

                const omdb = await fetchOmdbData(data.imdb_id);
                if (omdb) {
                    const omdbTags = mapOmdbToTags(omdb);
                    for (const [key, val] of Object.entries(omdbTags)) {
                        data['omdb_' + key] = val;
                    }
                }
            } catch (e) { console.warn("OMDb fetch failed:", e); }
        }
        // ------------------------

        lastFetchedData = data;

        // 1. Assets vorladen (Preload) - noch nichts am Canvas ändern!
        const assetPromises = [];
        let newLogoImg = null;

        if (data.logo_url) {
            assetPromises.push(new Promise(resolve => {
                const autoFix = document.getElementById('batchLogoAutoFix') ? document.getElementById('batchLogoAutoFix').checked : true;
                let proxiedLogo = `/api/proxy/image?url=${encodeURIComponent(data.logo_url)}`;
                if (!autoFix) {
                    proxiedLogo += "&raw=true";
                }
                fabric.Image.fromURL(proxiedLogo, (img) => { newLogoImg = img; resolve(); }, { crossOrigin: 'anonymous' });
            }));
        }
        await Promise.all(assetPromises);

        // 2. Apply Background (using fixed resolution logic)
        if (data.backdrop_url) {
            await loadBackground(data.backdrop_url, true, bgState || lastValidBgState);
        } else {
            // Remove existing background(s)
            const bgObjects = canvas.getObjects().filter(o => o.dataTag === 'background');
            bgObjects.forEach(o => canvas.remove(o));

            // Safety: Remove mainBg if it wasn't caught by the filter
            if (mainBg && !bgObjects.includes(mainBg)) {
                canvas.remove(mainBg);
            }
            mainBg = null;

            // Clear canvas background image if set
            if (canvas.backgroundImage) {
                canvas.setBackgroundImage(null, canvas.renderAll.bind(canvas));
            }

            // Remove existing fades
            const fadeObjects = canvas.getObjects().filter(o => o.dataTag === 'fade_effect');
            fadeObjects.forEach(o => canvas.remove(o));

            // Remove Ambilight if exists
            if (ambilightBg) {
                canvas.remove(ambilightBg);
                ambilightBg = null;
            }
            canvas.getObjects().filter(o => o.dataTag === 'ambilight_bg').forEach(o => canvas.remove(o));
        }

        await autoDetectBgColor(true, true);
        ensureSeerrProviderBadge(data);
        await previewTemplate(data, true, newLogoImg);
        saveToLocalStorage();
        canvas.renderAll(); // Force synchronous render to ensure image is ready

        // Safety Net
        updateVerticalLayout();
        setTimeout(() => {
            canvas.requestRenderAll();
            updateVerticalLayout();
        }, 500);

        const btnSaveGallery = document.getElementById('btn-save-gallery');
        if (btnSaveGallery) btnSaveGallery.disabled = false;

        if (!isBatchRunning) indicator.innerText = "Source: " + data.source;
    } catch (err) { console.error(err); indicator.innerText = "Error loading preview"; }
    finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}

function isSeerrMedia(data) {
    if (!data) return false;
    const id = String(data.id || '');
    const src = String(data.source || '');
    return id.startsWith('jellyseerr-') || id.startsWith('seerr-') || !!data.seerr_url || src.startsWith('Seerr') || src === 'Jellyseerr';
}

function shouldShowSeerrBadge(data) {
    if (!isSeerrMedia(data)) return false;
    const avail = data.availability;
    // Show on wallpaper when not already in the library
    return avail !== 'available' && avail !== 'partial';
}

function ensureSeerrProviderBadge(data) {
    if (!canvas || !shouldShowSeerrBadge(data)) return false;
    const existing = canvas.getObjects().find(o => o.dataTag === 'provider_source');
    if (existing) {
        existing.set('visible', true);
        return false;
    }

    // Place under title / lowest metadata row so it reads as part of the wallpaper
    const is4K = document.getElementById('resSelect') && document.getElementById('resSelect').value === '2160';
    const fontSize = is4K ? 48 : 32;
    const marginLeft = parseInt(document.getElementById('marginLeftInput')?.value) || 50;
    const elements = canvas.getObjects().filter(o => o.dataTag && o !== mainBg && o.visible && o.dataTag !== 'background' && o.dataTag !== 'fade_effect' && o.dataTag !== 'ambilight_bg');
    let left = marginLeft;
    let top = (canvas.height || 1080) * 0.82;
    const title = elements.find(o => o.dataTag === 'title');
    if (title) left = title.left;
    if (elements.length) {
        let maxBottom = 0;
        elements.forEach(el => {
            const bottom = el.top + el.getScaledHeight();
            if (bottom > maxBottom) maxBottom = bottom;
        });
        top = maxBottom + 24;
    }

    const placeholder = new fabric.IText(' ', {
        left,
        top,
        fontFamily: 'Roboto',
        fontSize,
        fill: 'white',
        shadow: '2px 2px 10px rgba(0,0,0,0.8)',
        dataTag: 'provider_source',
        editable: false
    });
    canvas.add(placeholder);
    return true;
}

function addSeerrAvailabilityBadge() {
    if (!lastFetchedData) return;
    if (ensureSeerrProviderBadge(lastFetchedData)) {
        previewTemplate(lastFetchedData);
    } else if (shouldShowSeerrBadge(lastFetchedData)) {
        previewTemplate(lastFetchedData);
    }
}

function previewTemplate(mediaData, skipRender = false, preloadedLogo = null) {
    return new Promise((resolve) => {
        if (!canvas || !mediaData) { resolve(); return; }

        // Helper to calculate smart positioning for the new logo
        const getNewLogoLeft = (oldObj, newWidth, newScale) => {
            const align = document.getElementById('tagAlignSelect').value;
            const marginLeft = parseInt(document.getElementById('marginLeftInput').value) || 50;
            const marginRight = parseInt(document.getElementById('marginRightInput').value) || 50;

            const cW = canvas.width;
            const oldW = oldObj.getScaledWidth();

            let boundsL = oldObj.left;
            let boundsR = oldObj.left + oldW;

            const isStickyLeft = Math.abs(boundsL - marginLeft) < 20;
            const isStickyRight = Math.abs(boundsR - (cW - marginRight)) < 20;

            if (isStickyLeft) return marginLeft;
            if (isStickyRight) return (cW - marginRight) - (newWidth * newScale);

            // Not sticky: preserve alignment anchor based on mode
            if (align === 'center') {
                const center = (boundsL + boundsR) / 2;
                return center - (newWidth * newScale) / 2;
            } else if (align === 'right') {
                return (oldObj.left + oldW) - (newWidth * newScale);
            } else {
                return oldObj.left;
            }
        };

        let promises = [];

        [...canvas.getObjects()].forEach(obj => {
            if (obj.dataTag) {

                // ----------------------------------

                let val = undefined; // Changed from "" to undefined to prevent accidental hiding of unhandled tags
                switch (obj.dataTag) {
                    case 'title':
                        if (mediaData.logo_url && preloadedLogo) {
                            const autoFix = document.getElementById('batchLogoAutoFix') ? document.getElementById('batchLogoAutoFix').checked : true;
                            // Benutze das vorgeladene Logo sofort (synchron)
                            
                            // Use slot dimensions if available (from layout), otherwise current dimensions
                            const slotW = obj.slotWidth || obj.getScaledWidth();
                            const slotH = obj.slotHeight || obj.getScaledHeight();

                            // Scale to fit within the slot while maintaining aspect ratio
                            const scale = Math.min(slotW / preloadedLogo.width, slotH / preloadedLogo.height);

                            const newLeft = getNewLogoLeft(obj, preloadedLogo.width, scale);

                            preloadedLogo.set({ 
                                left: newLeft, 
                                top: obj.top, 
                                dataTag: 'title', 
                                logoAutoFix: autoFix,
                                slotWidth: slotW,
                                slotHeight: slotH
                            });
                            preloadedLogo.scale(scale);
                            canvas.remove(obj); canvas.add(preloadedLogo);
                        } else if (mediaData.logo_url) {
                            const autoFix = document.getElementById('batchLogoAutoFix') ? document.getElementById('batchLogoAutoFix').checked : true;
                            const p = new Promise(r => {
                                let proxiedLogo = `/api/proxy/image?url=${encodeURIComponent(mediaData.logo_url)}`;
                                if (!autoFix) {
                                    proxiedLogo += "&raw=true";
                                }
                                fabric.Image.fromURL(proxiedLogo, function (img, isError) {
                                    if (isError || !img) { canvas.remove(obj); r(); return; }

                                    // --- STRICT FIXED HEIGHT LOGIC ---
                                    const targetHeight = obj.slotHeight || obj.getScaledHeight();
                                    img.scaleToHeight(targetHeight);

                                    // Check width constraints
                                    const marginLeft = parseInt(document.getElementById('marginLeftInput').value) || 50;
                                    const marginRight = parseInt(document.getElementById('marginRightInput').value) || 50;
                                    const maxW = canvas.width - marginLeft - marginRight;

                                    if (img.getScaledWidth() > maxW) {
                                        img.scaleToWidth(maxW);
                                    }

                                    const newLeft = getNewLogoLeft(obj, img.width, img.scaleX);

                                    img.set({ 
                                        left: newLeft, 
                                        top: obj.top, 
                                        dataTag: 'title', 
                                        logoAutoFix: autoFix,
                                        slotWidth: img.getScaledWidth(),
                                        slotHeight: img.getScaledHeight()
                                    });
                                    canvas.remove(obj); canvas.add(img);
                                    r();
                                }, { crossOrigin: 'anonymous' });
                            });
                            promises.push(p);
                            return;
                        } else {
                            val = mediaData.title || mediaData.Name;
                            // Fix: If switching from Logo (Image) to Text, replace the object
                            if (obj.type === 'image') {
                                const is4K = document.getElementById('resSelect').value === '2160';
                                const titleSize = is4K ? 120 : 80;
                                // Fix: Read alignment from UI controls, not mediaData
                                const uiAlign = document.getElementById('tagAlignSelect') ? document.getElementById('tagAlignSelect').value : 'left';
                                
                                // Use slot width for text box width if available
                                const slotW = obj.slotWidth || (canvas.width * 0.5);
                                const slotH = obj.slotHeight || obj.getScaledHeight();

                                // Calculate max width based on tags
                                const tagsW = getTagsMaxWidth();
                                let finalW = tagsW > 0 ? tagsW : slotW;

                                // Ensure we don't exceed canvas margins
                                const marginLeft = parseInt(document.getElementById('marginLeftInput').value) || 50;
                                const marginRight = parseInt(document.getElementById('marginRightInput').value) || 50;
                                const maxCanvasW = canvas.width - marginLeft - marginRight;
                                if (finalW > maxCanvasW) finalW = maxCanvasW;

                                const newText = new fabric.Textbox(val, {
                                    left: obj.left, top: obj.top,
                                    width: finalW,
                                    fontFamily: 'Roboto', fontSize: titleSize,
                                    fill: 'white', shadow: '2px 2px 10px rgba(0,0,0,0.8)',
                                    dataTag: 'title', editable: false,
                                    textAlign: uiAlign,
                                    splitByGrapheme: false,
                                    slotWidth: finalW,
                                    slotHeight: slotH
                                });

                                // 1. Shrink width to fit actual text content (longest line)
                                shrinkTextboxToContent(newText, finalW);

                                // 2. Scale to fit within the slot
                                // This handles both wrapping (if text is long) and scaling (if text is short/tall)
                                const scale = Math.min(finalW / newText.width, slotH / newText.height);
                                newText.scale(scale);

                                const newLeft = getNewLogoLeft(obj, newText.getScaledWidth(), 1);
                                newText.set('left', newLeft);

                                canvas.remove(obj); canvas.add(newText);
                            }
                        }
                        break;
                    case 'year':
                        val = mediaData.year;
                        if (val === undefined || val === null) val = mediaData.ProductionYear;
                        if (val === undefined) val = null;
                        break;
                    case 'rating':
                        let r = mediaData.rating || mediaData.CommunityRating;
                        if (r && r !== 'N/A' && !isNaN(parseFloat(r))) r = parseFloat(r).toFixed(1);
                        else r = null; // Invalid rating

                        if (obj.type === 'group') {
                            const t = obj.getObjects().find(o => o.type === 'i-text');
                            if (t) { t.set({ text: r ? `${r}` : '' }); obj.addWithUpdate(); }
                            val = undefined;
                            obj.set('visible', !!r);
                        } else {
                            val = r ? `IMDb: ${r}` : null;
                        }
                        break;
                    case 'rating_val':
                        let rv = mediaData.rating || mediaData.CommunityRating;
                        if (rv && rv !== 'N/A' && !isNaN(parseFloat(rv))) rv = parseFloat(rv).toFixed(1);
                        else rv = null;
                        val = rv ? `${rv}` : null;
                        break;
                    case 'rating_star':
                        let rs = mediaData.rating || mediaData.CommunityRating;
                        if (rs && rs !== 'N/A' && !isNaN(parseFloat(rs))) rs = parseFloat(rs).toFixed(1);
                        else rs = null;
                        val = rs ? `${rs}` : null;
                        if (obj.type === 'group') {
                            const t = obj.getObjects().find(o => o.type === 'i-text');
                            if (t) { t.set({ text: val || '' }); obj.addWithUpdate(); }
                            val = undefined;
                            obj.set('visible', !!rs);
                        }
                        break;
                    case 'overview':
                        let ov = mediaData.overview || mediaData.Overview || "";
                        if (obj.type === 'textbox') { 
                            obj.fullMediaText = ov;
                            const strOv = String(ov || "").trim();
                            if (strOv === "" || strOv === "N/A") {
                                obj.set('visible', false);
                            } else {
                                obj.set('visible', true);
                            }
                        } else { val = ov; }
                        break;
                    case 'genres':
                        val = mediaData.genres || "";
                        const gLimit = parseInt(document.getElementById('genreLimitSlider').value);
                        if (gLimit < 6) {
                            val = val.split(',').slice(0, gLimit).join(',');
                        }
                        break;
                    case 'availability':
                    case 'availability_label':
                        val = mediaData.availability_label || mediaData.availability || '';
                        break;
                    case 'runtime':
                        val = mediaData.runtime;
                        const rtCheck = String(val || "").toLowerCase().replace(/\s/g, '');
                        if (rtCheck === '0min' || rtCheck === '0') val = null;
                        break;
                    case 'officialRating':
                        val = mediaData.officialRating;
                        break;
                    case 'provider_source':
                        const srcVal = (mediaData.source || "Jellyfin");
                        let pText = "";
                        let pLogo = null;
                        const avail = mediaData.availability;

                        if (srcVal === 'TMDB') {
                            pText = "Now Trending on ";
                            pLogo = "tmdblogo.png";
                        } else if (srcVal === 'Trakt') {
                            pText = "Now on my watchlist ";
                            pLogo = "traktlogo.png";
                        } else if (srcVal && (srcVal.startsWith('Seerr') || srcVal === 'Jellyseerr')) {
                            // Logo-only Seerr mark (no status text)
                            pText = "";
                            pLogo = "seerrlogo.png";
                        } else if (['Sonarr', 'Radarr', 'Jellyseerr'].includes(srcVal) || (srcVal && srcVal.includes('Missing'))) {
                            pText = (srcVal && srcVal.includes('Missing')) ? "Requested on " : "Soon available on ";
                            pLogo = "jellyfinlogo.png";
                        } else {
                            pText = "Now available on ";
                            if (srcVal === 'Plex') pLogo = "plexlogo.png";
                            else pLogo = "jellyfinlogo.png";
                        }

                        if (pLogo) {
                            const p = new Promise(resolve => {
                                const logoUrl = `/static/provider_logos/${pLogo}`;
                                fabric.Image.fromURL(logoUrl, function (img, isError) {
                                    if (isError || !img) {
                                        // Fallback to text only
                                        obj.set({ text: pText + srcVal, visible: true });
                                        resolve();
                                        return;
                                    }

                                    // Robust property preservation
                                    let currentProps = {
                                        fontFamily: obj.fontFamily || 'Roboto',
                                        fontSize: obj.fontSize || 40,
                                        fill: obj.fill || 'white',
                                        shadow: obj.shadow || null,
                                        stroke: obj.stroke || null,
                                        strokeWidth: obj.strokeWidth || 0,
                                        textAlign: obj.textAlign || 'left'
                                    };

                                    if (obj.type === 'group' && obj.getObjects) {
                                        const t = obj.getObjects().find(o => o.type === 'i-text');
                                        if (t) {
                                            if (t.fontFamily) currentProps.fontFamily = t.fontFamily;
                                            if (t.fontSize) currentProps.fontSize = t.fontSize;
                                            if (t.fill) currentProps.fill = t.fill;
                                            if (t.shadow) currentProps.shadow = t.shadow;
                                            if (t.stroke) currentProps.stroke = t.stroke;
                                            if (t.strokeWidth !== undefined) currentProps.strokeWidth = t.strokeWidth;
                                            if (t.textAlign) currentProps.textAlign = t.textAlign;
                                        }
                                    }

                                    // Logo-only badge (e.g. Seerr)
                                    if (!pText) {
                                        const targetH = (currentProps.fontSize || 40) * 1.35;
                                        img.scaleToHeight(targetH);
                                        img.set({
                                            left: obj.left,
                                            top: obj.top,
                                            originX: obj.originX || 'left',
                                            originY: obj.originY || 'top',
                                            opacity: obj.opacity,
                                            angle: obj.angle,
                                            dataTag: 'provider_source',
                                            selectable: true
                                        });
                                        canvas.remove(obj);
                                        canvas.add(img);
                                        resolve();
                                        return;
                                    }

                                    // Create Text Component
                                    const textObj = new fabric.IText(pText, {
                                        fontFamily: currentProps.fontFamily,
                                        fontSize: currentProps.fontSize,
                                        fill: currentProps.fill,
                                        shadow: currentProps.shadow,
                                        stroke: currentProps.stroke,
                                        strokeWidth: currentProps.strokeWidth,
                                        textAlign: currentProps.textAlign,
                                        originY: 'center',
                                        originX: 'left',
                                        left: 0, top: 0,
                                        editable: false
                                    });


                                    // Scale Logo
                                    const targetH = textObj.height * textObj.scaleY;
                                    img.scaleToHeight(targetH * 1.2);
                                    img.set({ originY: 'center', originX: 'left', left: textObj.getScaledWidth() + 15, top: 0 });

                                    // Create Group
                                    const group = new fabric.Group([textObj, img], {
                                        left: obj.left, top: obj.top,
                                        originX: obj.originX, originY: obj.originY,
                                        scaleX: obj.scaleX, scaleY: obj.scaleY,
                                        angle: obj.angle, opacity: obj.opacity,
                                        fontFamily: currentProps.fontFamily, // Store font for next reload
                                        dataTag: 'provider_source',
                                        selectable: true // Editor allows selection
                                    });

                                    canvas.remove(obj);
                                    canvas.add(group);
                                    resolve();
                                });
                            });
                            promises.push(p);
                            val = undefined; // Signal that we handled it manually
                        } else {
                            val = pText + srcVal;
                        }
                        break;
                    case 'certification':
                        let cert = mediaData.officialRating || mediaData.certification || mediaData.OfficialRating;
                        let certUrl = null;

                        // 1. Try Official Rating string
                        if (cert) {
                            certUrl = getCertificationImageUrl(cert);
                        }

                        // 2. Fallback: If no URL found (or no official rating), try Inherited Value (Numeric)
                        if (!certUrl && mediaData.inheritedParentalRatingValue !== undefined) {
                            certUrl = getCertificationImageUrl(String(mediaData.inheritedParentalRatingValue));
                        }

                        if (certUrl) {
                            const p = new Promise(r => {
                                const urlToLoad = certUrl.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(certUrl)}` : certUrl;
                                fabric.Image.fromURL(urlToLoad, function (img, isError) {
                                    if (isError || !img) { obj.set('visible', false); r(); return; }
                                    const targetHeight = obj.getScaledHeight();
                                    img.scaleToHeight(targetHeight);
                                    img.set({ left: obj.left, top: obj.top, dataTag: 'certification' });
                                    if (obj.matchHeight) img.matchHeight = true;
                                    canvas.remove(obj);
                                    canvas.add(img);
                                    r();
                                }, { crossOrigin: 'anonymous', dataTag: 'certification' });
                            });
                            promises.push(p);
                            return;
                        } else {
                            obj.set('visible', false);
                        }
                        break;
                    case 'actors':
                        if (mediaData.actors && mediaData.actors.length > 0) {
                            obj.fullList = mediaData.actors;
                            const limit = obj.maxItems || mediaData.actors.length;
                            val = mediaData.actors.slice(0, limit).join(', ');
                        } else {
                            val = null;
                            obj.fullList = [];
                        }
                        break;
                    case 'directors':
                        if (mediaData.directors && mediaData.directors.length > 0) {
                            obj.fullList = mediaData.directors;
                            const limit = obj.maxItems || mediaData.directors.length;
                            val = mediaData.directors.slice(0, limit).join(', ');
                        } else {
                            val = null;
                            obj.fullList = [];
                        }
                        break;
                    case 'omdb_rotten_tomatoes':
                        val = mediaData.rotten_tomatoes;

                        // Ensure consistent origin for layout sorting
                        obj.set({ originX: 'left', originY: 'top' });
                        obj.setCoords();

                        // Restore snapping for OMDb tags (fix previous state)
                        obj.snapToObjects = true;

                        // Async fetch if missing
                        if (!val && obj.dataTag) {
                            const imdbId = mediaData.imdb_id || (mediaData.external_ids ? mediaData.external_ids.imdb_id : null) || (mediaData.ProviderIds ? mediaData.ProviderIds.Imdb : null) || mediaData.ImdbId || mediaData.imdbId;
                            if (imdbId) {
                                // Don't show stale data, but keep space reserved (opacity 0)
                                obj.set('opacity', 0);
                                obj.set('visible', true); // Ensure layout sees it

                                promises.push(fetchOmdbData(imdbId).then(data => {
                                    if (data) {
                                        const tags = mapOmdbToTags(data);
                                        const newVal = tags.rotten_tomatoes;
                                        if (newVal) {
                                            if (obj.type === 'group') {
                                                const t = obj.getObjects().find(o => o.type === 'i-text');
                                                const img = obj.getObjects().find(o => o.type === 'image');
                                                if (t) {
                                                    t.set({ text: newVal + '%' });
                                                    if (img) {
                                                        t.setCoords();
                                                        const th = t.getScaledHeight();
                                                        img.scaleToHeight(th * 1.0);
                                                        img.set({ top: 0, left: 0 });
                                                        t.set({ left: img.getScaledWidth() + 15, top: 0 });
                                                    }
                                                    const preservedTop = obj.top;
                                                    const preservedLeft = obj.left;
                                                    obj.addWithUpdate();
                                                    obj.set('top', preservedTop);
                                                    obj.set('left', preservedLeft);
                                                    obj.setCoords();
                                                }
                                                // Data ready: Show tag
                                                obj.set('opacity', 1);
                                                obj.set('visible', true);
                                                canvas.requestRenderAll();
                                                setTimeout(() => updateVerticalLayout(), 50); // Recalculate layout with new width
                                            }
                                        } else {
                                            // Valid data fetched but no RT score -> Hide fully
                                            obj.set('visible', false);
                                            canvas.requestRenderAll();
                                            setTimeout(() => updateVerticalLayout(), 50);
                                        }
                                    }
                                }));
                                val = undefined; // Signal async handling
                            } else {
                                // No ID -> Hide fully
                                obj.set('visible', false);
                                setTimeout(() => updateVerticalLayout(), 50);
                                val = undefined;
                            }
                        }

                        if (obj.type === 'group') {
                            // Check if we have a valid value (synchronous path)
                            // If val is undefined here, it means either it was missing from data OR async fetch took over (val set to undefined)
                            // If async took over, we don't touch visibility here (async callback handles it)
                            // If it was just missing, we should hide it.
                            
                            if (val !== undefined) {
                                const strVal = (val === null) ? "" : String(val).trim();
                                const isValid = strVal !== "" && strVal !== "N/A";
                                
                                obj.set('visible', isValid);
                                if (isValid) obj.set('opacity', 1);
                                
                                if (isValid) {
                                    const t = obj.getObjects().find(o => o.type === 'i-text');
                                    const img = obj.getObjects().find(o => o.type === 'image');
                                    if (t) {
                                        t.set({ text: val ? val + '%' : '' });
                                        if (img) {
                                            t.setCoords(); // Update dim
                                            const th = t.getScaledHeight();
                                            img.scaleToHeight(th * 1.0);
                                            img.set({ top: 0, left: 0 });
                                            t.set({ left: img.getScaledWidth() + 15, top: 0 });
                                        }
                                        const preservedTop = obj.top;
                                        const preservedLeft = obj.left;
                                        obj.addWithUpdate();
                                        obj.set('top', preservedTop);
                                        obj.set('left', preservedLeft);
                                        obj.setCoords();
                                    }
                                }
                                val = undefined; // Prevent generic handler
                            } else if (!obj.dataTag || !mediaData.imdb_id) {
                                // If no value and no async fetch possible (no ID), hide it
                                obj.set('visible', false);
                            }
                        }
                        break;
/*
                        if (obj.type === 'group' && val !== undefined) {
                            const t = obj.getObjects().find(o => o.type === 'i-text');
                            const img = obj.getObjects().find(o => o.type === 'image');
                            if (t) {
                                t.set({ text: val ? val + '%' : '' });
                                if (img) {
                                    t.setCoords(); // Update dim
                                    const th = t.getScaledHeight();
                                    img.scaleToHeight(th * 1.0);
                                    img.set({ top: 0, left: 0 });
                                    t.set({ left: img.getScaledWidth() + 15, top: 0 });
                                }
                                const preservedTop = obj.top;
                                const preservedLeft = obj.left;
                                obj.addWithUpdate();
                                obj.set('top', preservedTop);
                                obj.set('left', preservedLeft);
                                obj.setCoords();
                            }
                            // Force visibility if it has a value OR if it's a placeholder (handled above by async block setting val=undefined)
                            // If val is NOT undefined here, it means it was present in mediaData.
                            obj.set('visible', !!val);
                            val = undefined; // handled
                        }
*/
                    case 'omdb_metacritic':
                        val = mediaData.metacritic;

                        // Ensure consistent origin for layout sorting
                        obj.set({ originX: 'left', originY: 'top' });
                        obj.setCoords();

                        // Restore snapping for OMDb tags (fix previous state)
                        obj.snapToObjects = true;

                        // Async fetch if missing
                        if (!val && obj.dataTag) {
                            const imdbId = mediaData.imdb_id || (mediaData.external_ids ? mediaData.external_ids.imdb_id : null) || (mediaData.ProviderIds ? mediaData.ProviderIds.Imdb : null) || mediaData.ImdbId || mediaData.imdbId;
                            if (imdbId) {
                                // Don't show stale data, but keep space reserved (opacity 0)
                                obj.set('opacity', 0);
                                obj.set('visible', true); // Ensure layout sees it

                                promises.push(fetchOmdbData(imdbId).then(data => {
                                    if (data) {
                                        const tags = mapOmdbToTags(data);
                                        const newVal = tags.metacritic;
                                        if (newVal) {
                                            if (obj.type === 'group') {
                                                const t = obj.getObjects().find(o => o.type === 'i-text');
                                                const img = obj.getObjects().find(o => o.type === 'image');
                                                if (t) {
                                                    t.set({ text: newVal || '' });
                                                    if (img) {
                                                        t.setCoords();
                                                        const th = t.getScaledHeight();
                                                        img.scaleToHeight(th * 1.0);
                                                        img.set({ top: 0, left: 0 });
                                                        t.set({ left: img.getScaledWidth() + 15, top: 0 });
                                                    }
                                                    const preservedTop = obj.top;
                                                    const preservedLeft = obj.left;
                                                    obj.addWithUpdate();
                                                    obj.set('top', preservedTop);
                                                    obj.set('left', preservedLeft);
                                                    obj.setCoords();
                                                }
                                                // Data ready: Show tag
                                                obj.set('opacity', 1);
                                                obj.set('visible', true);
                                                canvas.requestRenderAll();
                                                setTimeout(() => updateVerticalLayout(), 50); // Recalculate layout with new width
                                            }
                                        } else {
                                            // Valid data fetched but no Metacritic score -> Hide fully
                                            obj.set('visible', false);
                                            canvas.requestRenderAll();
                                            setTimeout(() => updateVerticalLayout(), 50);
                                        }
                                    }
                                }));
                                val = undefined; // Signal async handling
                            } else {
                                // No ID -> Hide fully
                                obj.set('visible', false);
                                setTimeout(() => updateVerticalLayout(), 50);
                                val = undefined;
                            }
                        }

                        if (obj.type === 'group') {
                            if (val !== undefined) {
                                const strVal = (val === null) ? "" : String(val).trim();
                                const isValid = strVal !== "" && strVal !== "N/A";
                                
                                obj.set('visible', isValid);
                                if (isValid) obj.set('opacity', 1);
                                
                                if (isValid) {
                                    const t = obj.getObjects().find(o => o.type === 'i-text');
                                    const img = obj.getObjects().find(o => o.type === 'image');
                                    if (t) {
                                        t.set({ text: val || '' });
                                        if (img) {
                                            t.setCoords();
                                            const th = t.getScaledHeight();
                                            img.scaleToHeight(th * 1.0);
                                            img.set({ top: 0, left: 0 });
                                            t.set({ left: img.getScaledWidth() + 15, top: 0 });
                                        }
                                        const preservedTop = obj.top;
                                        const preservedLeft = obj.left;
                                        obj.addWithUpdate();
                                        obj.set('top', preservedTop);
                                        obj.set('left', preservedLeft);
                                        obj.setCoords();
                                    }
                                }
                                val = undefined;
                            } else if (!obj.dataTag || !mediaData.imdb_id) {
                                obj.set('visible', false);
                            }
                        }
                        break;
/*
                        if (obj.type === 'group' && val !== undefined) {
                            const t = obj.getObjects().find(o => o.type === 'i-text');
                            const img = obj.getObjects().find(o => o.type === 'image');
                            if (t) {
                                t.set({ text: val || '' });
                                if (img) {
                                    t.setCoords();
                                    const th = t.getScaledHeight();
                                    img.scaleToHeight(th * 1.0);
                                    img.set({ top: 0, left: 0 });
                                    t.set({ left: img.getScaledWidth() + 15, top: 0 });
                                }
                                const preservedTop = obj.top;
                                const preservedLeft = obj.left;
                                obj.addWithUpdate();
                                obj.set('top', preservedTop);
                                obj.set('left', preservedLeft);
                                obj.setCoords();
                            }
                            obj.set('visible', !!val);
                            val = undefined;
                        }
*/
                    default:
                        val = mediaData[obj.dataTag];
                        break;
                }

                // Only update visibility for tags that actually produced a value (or explicit null)
                if (val !== undefined && obj.dataTag !== 'overview' && obj.dataTag !== 'background' && obj.dataTag !== 'fade_effect' && obj.dataTag !== 'guide_overlay') {
                    const strVal = (val === null || val === undefined) ? "" : String(val).trim();
                    if (strVal === "" || strVal === "N/A") {
                        obj.set('visible', false);
                    } else {
                        // Apply automatic wrapping for actors/directors
                        if ((obj.dataTag === 'actors' || obj.dataTag === 'directors') && obj.type === 'i-text') {
                            // Migration: Convert IText to Textbox for wrapping support
                            const props = obj.toObject(['dataTag', 'maxItems', 'fullList']);
                            delete props.type;
                            const newObj = new fabric.Textbox(String(val), {
                                ...props,
                                width: canvas.width * 0.5,
                                splitByGrapheme: false,
                                editable: false,
                                visible: true
                            });
                            canvas.remove(obj);
                            canvas.add(newObj);
                            obj = newObj; // Continue with the new object
                        } else if ((obj.dataTag === 'actors' || obj.dataTag === 'directors') && obj.type === 'textbox') {
                            obj.set({ width: canvas.width * 0.5, text: String(val), visible: true });
                        } else {
                            obj.set({ text: String(val), visible: true });
                        }
                    }
                }
            }
        });

        Promise.all(promises).then(() => {
            document.fonts.ready.then(() => {
                canvas.renderAll(); // Force dimension update before layout
                // Re-run fitTextToContainer for overview to ensure correct sizing with loaded fonts
                canvas.getObjects().forEach(obj => {
                    if (obj.dataTag === 'overview' && obj.type === 'textbox') {
                        fitTextToContainer(obj);
                    } else if ((obj.dataTag === 'actors' || obj.dataTag === 'directors') && obj.type === 'textbox') {
                        shrinkTextboxToContent(obj, canvas.width * 0.5);
                    }
                });
                updateVerticalLayout(skipRender).then(resolve);
            });
        });
    });
}

let detectedBaseColor = null;

function autoDetectBgColor(forceRecalc, skipRender = false) {
    if (!mainBg) return Promise.resolve();

    if (forceRecalc || !detectedBaseColor) {
        const img = mainBg.getElement();
        const cvs = document.createElement('canvas');
        cvs.width = img.naturalWidth || img.width;
        cvs.height = img.naturalHeight || img.height;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const frame = 50;
        const w = cvs.width, h = cvs.height;
        let r = 0, g = 0, b = 0, count = 0;

        try {
            const data = ctx.getImageData(0, 0, w, h).data;
            const step = 20;
            for (let y = 0; y < h; y += step) {
                for (let x = 0; x < w; x += step) {
                    if (x < frame || x > w - frame || y < frame || y > h - frame) {
                        const i = (y * w + x) * 4;
                        r += data[i]; g += data[i + 1]; b += data[i + 2];
                        count++;
                    }
                }
            }
        } catch (e) { console.error("Pixel access error", e); return; }

        if (count > 0) {
            detectedBaseColor = { r: Math.floor(r / count), g: Math.floor(g / count), b: Math.floor(b / count) };
        }
    }
    return applyBrightness(skipRender);
}

function adjustAutoBrightness() {
    document.getElementById('brightVal').innerText = document.getElementById('bgBrightness').value + '%';
    if (detectedBaseColor) {
        applyBrightness();
    } else if (mainBg) {
        autoDetectBgColor(true);
    }
}

function applyBrightness(skipRender = false) {
    if (!detectedBaseColor) return Promise.resolve();
    const factor = parseInt(document.getElementById('bgBrightness').value) / 100;
    let r = Math.floor(detectedBaseColor.r * factor);
    let g = Math.floor(detectedBaseColor.g * factor);
    let b = Math.floor(detectedBaseColor.b * factor);
    const hex = "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    document.getElementById('bgColor').value = hex;
    return updateBgColor(skipRender);
}

function addMetadataTag(type, placeholder) {
    const is4K = document.getElementById('resSelect').value === '2160';
    const baseSize = is4K ? 54 : 35;
    const titleSize = is4K ? 120 : 80;

    // 1. Smart Positioning Strategy
    let targetLeft = 100;
    let targetTop = 100;
    const activeObj = canvas.getActiveObject();

    if (activeObj && activeObj !== mainBg && activeObj.visible) {
        // Append to right of selected object (Row building)
        targetLeft = activeObj.left + activeObj.getScaledWidth() + 20;
        targetTop = activeObj.top;
    } else {
        // Find lowest element to start a new row
        const elements = canvas.getObjects().filter(o => o.dataTag && o !== mainBg && o.visible);
        if (elements.length > 0) {
            let maxBottom = 0;
            let alignLeft = 100;

            // Try to align with the Title if available
            const title = elements.find(o => o.dataTag === 'title');
            if (title) alignLeft = title.left;

            elements.forEach(el => {
                const bottom = el.top + el.getScaledHeight();
                if (bottom > maxBottom) maxBottom = bottom;
            });

            targetTop = maxBottom + 20;
            targetLeft = alignLeft;
        }
    }

    const props = {
        left: targetLeft,
        top: targetTop,
        fontFamily: 'Roboto',
        fontSize: type === 'title' ? titleSize : baseSize,
        fill: 'white',
        shadow: '2px 2px 10px rgba(0,0,0,0.8)',
        dataTag: type
    };

    // Helper to add object and trigger layout update
    const finalize = (obj) => {
        canvas.add(obj);
        canvas.setActiveObject(obj);
        updateVerticalLayout();
        saveToLocalStorage();
    };

    if (type === 'rating_star') {
        const starUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/Gold_Star.svg/1024px-Gold_Star.svg.png';
        const proxiedUrl = `/api/proxy/image?url=${encodeURIComponent(starUrl)}`;
        fabric.Image.fromURL(proxiedUrl, function (img) {
            if (!img) return;
            img.scaleToHeight(props.fontSize).set({ dataTag: 'rating_star_img' });
            const text = new fabric.IText(placeholder, { ...props, left: img.getScaledWidth() + 10, top: 0, editable: false });
            const group = new fabric.Group([img, text], { left: props.left, top: props.top, dataTag: type });
            finalize(group);
        }, { crossOrigin: 'anonymous' });
        return;
    }

    if (type === 'certification') {
        const defaultUrl = '/api/certification/FSK_16.svg';
        const urlToLoad = defaultUrl.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(defaultUrl)}` : defaultUrl;
        fabric.Image.fromURL(urlToLoad, function (img, isError) {
            if (isError || !img) { console.error("Failed to load certification image"); return; }
            img.scaleToHeight(props.fontSize * 1.5);
            img.set({ left: props.left, top: props.top, dataTag: type });
            finalize(img);
        }, { crossOrigin: 'anonymous', dataTag: type });
        return;
    }

    if (type === 'rating') {
        const logoUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/IMDB_Logo_2016.svg/1200px-IMDB_Logo_2016.svg.png';
        const proxiedUrl = `/api/proxy/image?url=${encodeURIComponent(logoUrl)}`;
        fabric.Image.fromURL(proxiedUrl, function (img) {
            if (!img) return;
            img.scaleToHeight(props.fontSize).set({ dataTag: 'rating_logo_img' });
            const textVal = placeholder.replace('IMDb: ', '');
            const text = new fabric.IText(textVal, { ...props, left: img.getScaledWidth() + 10, top: 0, editable: false });
            text.set('top', (img.getScaledHeight() - text.getScaledHeight()) / 2);
            const group = new fabric.Group([img, text], { left: props.left, top: props.top, dataTag: type });
            finalize(group);
        }, { crossOrigin: 'anonymous' });
        return;
    }

    let textObj;
    if (type === 'overview') {
        textObj = new fabric.Textbox(placeholder, { ...props, width: 600, height: 300, fixedHeight: 300, splitByGrapheme: false, lockScalingY: false, fullMediaText: placeholder, editable: false, objectCaching: false });
        fitTextToContainer(textObj);
    } else if (type === 'actors' || type === 'directors') {
        textObj = new fabric.Textbox(placeholder, { ...props, width: canvas.width * 0.5, splitByGrapheme: false, editable: false });
        shrinkTextboxToContent(textObj, canvas.width * 0.5);
    } else {
        textObj = new fabric.IText(placeholder, { ...props, editable: false });
    }
    finalize(textObj);
}

function addLogo(url) {
    const proxiedUrl = url.startsWith('/') ? url : `/api/proxy/image?url=${encodeURIComponent(url)}`;
    fabric.Image.fromURL(proxiedUrl, function (img) {
        if (!img) return;

        // --- START: New aggressive Smart-Resize Logic ---

        // 1. Define base limits (Standard for wide logos)
        // Width: max 55% of canvas, Height: max 35% of canvas
        const baseMaxW = canvas.width * 0.55;
        const baseMaxH = canvas.height * 0.35;

        // 2. Check aspect ratio
        const ratio = img.width / img.height;
        let allowedHeight = baseMaxH;

        // 3. Case distinction (Adjust hardness here)
        if (ratio < 0.65) {
            // CASE: Extremely Tall (like "November")
            // Allow only 50% of normal height, otherwise it looks huge.
            allowedHeight = baseMaxH * 0.50;
        }
        else if (ratio < 1.2) {
            // CASE: Square or compact
            // Allow 75% of normal height.
            allowedHeight = baseMaxH * 0.75;
        }
        else {
            // CASE: Normal Wide Logo
            // Can use full height.
        }

        // 4. Calculate final scale factor
        // Image must fit in width (baseMaxW) AND new height (allowedHeight)
        let scaleFactor = Math.min(baseMaxW / img.width, allowedHeight / img.height);

        // Safety padding (optional 90%)
        scaleFactor *= 0.9;

        img.scale(scaleFactor);

        const count = canvas.getObjects().length;
        const offset = count * 20;
        img.set({ left: 100 + offset, top: 100 + offset });
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.requestRenderAll();
        updateVerticalLayout();
        saveToLocalStorage();
    }, { crossOrigin: 'anonymous', dataTag: 'icon' });
}

function getCertificationImageUrl(rating) {
    if (!rating) return null;
    let r = String(rating).toUpperCase();
    let clean = r.replace(/[\s-]/g, ''); // Remove spaces and dashes: "DE-12" -> "DE12"

    // FSK (German)
    if (clean === 'FSK0' || clean === '0' || clean === 'DE0') return '/api/certification/FSK_0.svg';
    if (clean === 'FSK6' || clean === '6' || clean === 'DE6') return '/api/certification/FSK_6.svg';
    if (clean === 'FSK12' || clean === '12' || clean === 'DE12') return '/api/certification/FSK_12.svg';
    if (clean === 'FSK16' || clean === '16' || clean === 'DE16') return '/api/certification/FSK_16.svg';
    if (clean === 'FSK18' || clean === '18' || clean === 'DE18') return '/api/certification/FSK_18.svg';

    // Common German variations (e.g. "ab 6")
    if (clean === 'AB0' || clean === 'AB0JAHREN') return '/api/certification/FSK_0.svg';
    if (clean === 'AB6' || clean === 'AB6JAHREN') return '/api/certification/FSK_6.svg';
    if (clean === 'AB12' || clean === 'AB12JAHREN') return '/api/certification/FSK_12.svg';
    if (clean === 'AB16' || clean === 'AB16JAHREN') return '/api/certification/FSK_16.svg';
    if (clean === 'AB18' || clean === 'AB18JAHREN') return '/api/certification/FSK_18.svg';

    // MPAA (US)
    if (clean === 'G' || clean === 'USG') return 'https://upload.wikimedia.org/wikipedia/commons/0/05/RATED_G.svg';
    if (clean === 'PG' || clean === 'USPG') return 'https://upload.wikimedia.org/wikipedia/commons/b/bc/RATED_PG.svg';
    if (clean === 'PG13' || clean === 'USPG13') return 'https://upload.wikimedia.org/wikipedia/commons/c/c0/RATED_PG-13.svg';
    if (clean === 'R' || clean === 'USR') return 'https://upload.wikimedia.org/wikipedia/commons/7/7e/RATED_R.svg';
    if (clean === 'NC17' || clean === 'USNC17') return 'https://upload.wikimedia.org/wikipedia/commons/5/50/RATED_NC-17.svg';

    // TV Ratings (US)
    if (clean === 'TVY' || clean === 'USTVY') return 'https://upload.wikimedia.org/wikipedia/commons/2/25/TV-Y_icon.svg';
    if (clean === 'TVY7' || clean === 'USTVY7') return 'https://upload.wikimedia.org/wikipedia/commons/5/5a/TV-Y7_icon.svg';
    if (clean === 'TVG' || clean === 'USTVG') return 'https://upload.wikimedia.org/wikipedia/commons/5/5e/TV-G_icon.svg';
    if (clean === 'TVPG' || clean === 'USTVPG') return 'https://upload.wikimedia.org/wikipedia/commons/9/9a/TV-PG_icon.svg';
    if (clean === 'TV14' || clean === 'USTV14') return 'https://upload.wikimedia.org/wikipedia/commons/c/c3/TV-14_icon.svg';
    if (clean === 'TVMA' || clean === 'USTVMA') return 'https://upload.wikimedia.org/wikipedia/commons/3/34/TV-MA_icon.svg';
    return null;
}

function updateGenreLimit() {
    const val = document.getElementById('genreLimitSlider').value;
    document.getElementById('genreLimitVal').innerText = (val == 6) ? "Max" : val;

    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => {
        if (lastFetchedData) previewTemplate(lastFetchedData);
    }, 200);
}

function groupElementsByRow(elements, threshold = 30) {
    if (!elements.length) return [];

    elements.sort((a, b) => a.top - b.top);

    const rows = [];
    let currentRow = [elements[0]];

    for (let i = 1; i < elements.length; i++) {
        if (Math.abs(elements[i].top - currentRow[0].top) < threshold) {
            currentRow.push(elements[i]);
        } else {
            rows.push(currentRow);
            currentRow = [elements[i]];
        }
    }
    rows.push(currentRow);
    return rows;
}

function checkCollision(obj, blockedAreas, scaleFactor = 1) {
    if (!blockedAreas || blockedAreas.length === 0) return false;
    const b = obj.getBoundingRect();
    return blockedAreas.some(area => {
        const aLeft = area.left * scaleFactor;
        const aTop = area.top * scaleFactor;
        const aWidth = area.width * scaleFactor;
        const aHeight = area.height * scaleFactor;

        return (b.left < aLeft + aWidth &&
            b.left + b.width > aLeft &&
            b.top < aTop + aHeight &&
            b.top + b.height > aTop);
    });
}

function getTagsMaxWidth() {
    const elements = canvas.getObjects().filter(o => {
        if (['background', 'title', 'guide', 'fade_effect', 'grid_line', 'guide_overlay', 'ambilight_bg', 'separator', 'row_separator'].includes(o.dataTag)) return false;
        if (!o.dataTag) return false;
        if (o.visible === false) return false;
        return true;
    });

    const hPadding = parseInt(document.getElementById('tagPaddingInput').value) || 20;
    const rows = groupElementsByRow(elements, 4);
    let maxRowWidth = 0;
    rows.forEach(row => {
        let w = 0;
        row.forEach((el, i) => {
            const pad = el.padding || 0;
            w += (el.getScaledWidth()) + (pad * 2);
            if (i < row.length - 1) w += hPadding;
        });
        if (w > maxRowWidth) maxRowWidth = w;
    });
    return maxRowWidth;
}

function updateVerticalLayout(skipRender = false, retryCount = 0) {
    if (!canvas) return Promise.resolve();

    // Remove existing separators (Optimized: remove all at once)
    const separators = canvas.getObjects().filter(o => o.dataTag === 'separator');
    const rowSeparators = canvas.getObjects().filter(o => o.dataTag === 'row_separator');
    const toRemove = [...separators, ...rowSeparators];
    if (toRemove.length > 0) canvas.remove(...toRemove);

    // 1. Check for unready images (width/height 0)
    const unreadyImages = canvas.getObjects().some(o =>
        o.type === 'image' && o.visible && (o.width === 0 || o.height === 0)
    );

    if (unreadyImages) {
        return new Promise(resolve => {
            setTimeout(() => resolve(updateVerticalLayout(skipRender, retryCount)), 100);
        });
    }

    return document.fonts.ready.then(() => {
        const lineSpacingInput = document.getElementById('lineSpacingInput');
        const padding = lineSpacingInput ? parseInt(lineSpacingInput.value) : 20;
        const tagPaddingInput = document.getElementById('tagPaddingInput');
        const hPadding = tagPaddingInput ? parseInt(tagPaddingInput.value) : 20;
        const separatorChar = document.getElementById('tagSeparatorInput') ? document.getElementById('tagSeparatorInput').value : '';
        const separatorSize = document.getElementById('tagSeparatorSizeInput') ? parseInt(document.getElementById('tagSeparatorSizeInput').value) : 30;
        const separatorColor = document.getElementById('tagSeparatorColorInput') ? document.getElementById('tagSeparatorColorInput').value : '#ffffff';
        const separatorOpacity = document.getElementById('tagSeparatorOpacityInput') ? (parseInt(document.getElementById('tagSeparatorOpacityInput').value) / 100) : 1.0;

        const rowSeparatorStyle = document.getElementById('rowSeparatorStyle') ? document.getElementById('rowSeparatorStyle').value : '';
        const rowSeparatorThickness = document.getElementById('rowSeparatorThickness') ? parseInt(document.getElementById('rowSeparatorThickness').value) : 2;
        const rowSeparatorColor = document.getElementById('rowSeparatorColor') ? document.getElementById('rowSeparatorColor').value : '#ffffff';
        const rowSeparatorOpacity = document.getElementById('rowSeparatorOpacityInput') ? (parseInt(document.getElementById('rowSeparatorOpacityInput').value) / 100) : 1.0;
        const rowSeparatorAlign = document.getElementById('rowSeparatorAlign') ? document.getElementById('rowSeparatorAlign').value : 'center';
        const rowSeparatorAutoWidth = document.getElementById('rowSeparatorAutoWidth') ? document.getElementById('rowSeparatorAutoWidth').checked : true;
        const rowSeparatorWidth = document.getElementById('rowSeparatorWidth') ? parseInt(document.getElementById('rowSeparatorWidth').value) : 500;

        const rowThreshold = 4; // How close elements must be to be considered in the same row

        const marginTop = parseInt(document.getElementById('marginTopInput').value) || 50;
        const marginBottom = parseInt(document.getElementById('marginBottomInput').value) || 50;
        const marginLeft = parseInt(document.getElementById('marginLeftInput').value) || 50;
        const marginRight = parseInt(document.getElementById('marginRightInput').value) || 50;

        const currentRes = document.getElementById('resSelect') ? document.getElementById('resSelect').value : '1080';
        const scaleFactor = (currentRes === '2160') ? 2 : 1;

        // REMOVED: canvas.renderAll(); -- This caused the lag! Fabric calculates dimensions automatically on setCoords/text change.

        const anchor = canvas.getObjects().find(o => o.dataTag === 'title');
        if (!anchor) { canvas.requestRenderAll(); return; }

        // Restore preferred size at start of fresh layout calculation (Grow back logic)
        if (retryCount === 0 && anchor.type === 'image' && typeof preferredLogoWidth !== 'undefined' && preferredLogoWidth && anchor.dataTag !== 'title') {
            // NEW: Respect both width and height slots to prevent square logos from exploding
            const slotW = anchor.slotWidth || preferredLogoWidth;
            const slotH = anchor.slotHeight || (canvas.height * 0.35); // Fallback safe height
            
            // Scale to fit within the slot box (contain)
            const scale = Math.min(slotW / anchor.width, slotH / anchor.height);
            anchor.scale(scale);
        }

        // Auto-switch alignment based on position (Left vs Right)
        const alignSelect = document.getElementById('tagAlignSelect');
        //if (alignSelect.value !== 'center') {
        //    const centerX = anchor.left + (anchor.getScaledWidth() / 2);
        //    alignSelect.value = (centerX > canvas.width / 2) ? 'right' : 'left';
        //}
        const alignment = alignSelect.value;

        // Sync text alignment for overview and provider_source based on explicit text alignment setting
        const textAlignment = document.getElementById('textContentAlignSelect').value;
        canvas.getObjects().forEach(o => {
            if ((o.dataTag === 'overview' || o.dataTag === 'provider_source') && (o.type === 'textbox' || o.type === 'i-text')) {
                o.set('textAlign', textAlignment);
                o.set('dirty', true);
            }
        });

        // Ensure anchor (Logo/Title) respects screen margin
        if (anchor.left < marginLeft) anchor.set('left', marginLeft);
        if (anchor.left + anchor.getScaledWidth() > canvas.width - marginRight) {
            anchor.set('left', Math.max(marginLeft, canvas.width - marginRight - anchor.getScaledWidth()));
        }

        // Vertical constraint for anchor (Top & Bottom)
        if (anchor.top < marginTop) anchor.set('top', marginTop);
        if (anchor.top + anchor.getScaledHeight() > canvas.height - marginBottom) {
            anchor.set('top', Math.max(marginTop, canvas.height - marginBottom - anchor.getScaledHeight()));
        }
        anchor.setCoords();

        // 2.5. Auto-Scale Anchor to fit in vertical gaps between blocked areas
        if (activeBlockedAreas.length > 0) {
            // First pass: Calculate initial block dimensions to understand space needs
            const elements = canvas.getObjects().filter(o => {
                if (o.dataTag === 'background') return false;
                if (o.dataTag === 'title') return false;
                if (['guide', 'fade_effect', 'grid_line', 'guide_overlay', 'ambilight_bg', 'separator', 'row_separator'].includes(o.dataTag)) return false;
                if (!o.dataTag || o.snapToObjects === false) return false;
                return true;
            });
            const rows = groupElementsByRow(elements, 4);
            let tagsH = 0;
            let blockLeft = anchor.left;
            let blockRight = anchor.left + anchor.getScaledWidth();

            rows.forEach(row => {
                let maxH = 0;
                row.forEach(el => {
                    const b = el.getBoundingRect();
                    if (b.left < blockLeft) blockLeft = b.left;
                    if (b.left + b.width > blockRight) blockRight = b.left + b.width;
                    const h = el.getScaledHeight() + ((el.padding || 0) * 2);
                    if (h > maxH) maxH = h;
                });
                tagsH += maxH + padding;
            });

            const blockH = anchor.getScaledHeight() + tagsH;
            const anchorCenterY = anchor.top + (anchor.getScaledHeight() / 2);

            // Define vertical boundaries (obstacles) based on COMPREHENSIVE X range of all items
            const obstacles = [];
            obstacles.push({ top: -Infinity, bottom: marginTop });
            obstacles.push({ top: canvas.height - marginBottom, bottom: Infinity });

            activeBlockedAreas.forEach(area => {
                const aLeft = area.left * scaleFactor;
                const aWidth = area.width * scaleFactor;
                const aRight = aLeft + aWidth;

                // Check horizontal intersection with ANY part of the layout block
                if (aLeft < blockRight && aRight > blockLeft) {
                    const aTop = area.top * scaleFactor;
                    const aHeight = area.height * scaleFactor;
                    obstacles.push({ top: aTop, bottom: aTop + aHeight });
                }
            });

            // Sort and merge
            obstacles.sort((a, b) => a.top - b.top);
            const merged = [];
            if (obstacles.length > 0) {
                let curr = obstacles[0];
                for (let i = 1; i < obstacles.length; i++) {
                    if (obstacles[i].top < curr.bottom) {
                        curr.bottom = Math.max(curr.bottom, obstacles[i].bottom);
                    } else {
                        merged.push(curr);
                        curr = obstacles[i];
                    }
                }
                merged.push(curr);
            }

            // Find gaps
            const gaps = [];
            for (let i = 0; i < merged.length - 1; i++) {
                const top = merged[i].bottom;
                const bottom = merged[i + 1].top;
                if (bottom > top) {
                    gaps.push({ top, bottom, height: bottom - top });
                }
            }

            // Find relevant gap (closest to center)
            let bestGap = gaps.find(g => anchorCenterY >= g.top && anchorCenterY <= g.bottom);

            if (!bestGap && gaps.length > 0) {
                bestGap = gaps.reduce((prev, curr) => {
                    const prevDist = Math.min(Math.abs(anchorCenterY - prev.top), Math.abs(anchorCenterY - prev.bottom));
                    const currDist = Math.min(Math.abs(anchorCenterY - curr.top), Math.abs(anchorCenterY - curr.bottom));
                    return (currDist < prevDist) ? curr : prev;
                });
            }

            if (bestGap) {
                const currentH = anchor.getScaledHeight();
                const currentBlockH = blockH;
                const maxBlockH = Math.max(20, bestGap.height - 10);

                let targetAnchorH = currentH;
                if (preferredLogoWidth && anchor.type === 'image') {
                    const aspect = anchor.width / anchor.height;
                    targetAnchorH = preferredLogoWidth / aspect;
                }

                // If current block is too big for total gap, calculate required anchor reduction
                const tagsHConst = tagsH;
                const finalAnchorH = Math.min(targetAnchorH, maxBlockH - tagsHConst);
                const finalH = Math.max(20, finalAnchorH);

                // Apply if different (with small tolerance to avoid jitter)
                if (Math.abs(finalH - currentH) > 1 && anchor.dataTag !== 'title') {
                    const oldLeft = anchor.left;
                    const oldWidth = anchor.getScaledWidth();
                    const oldRight = oldLeft + oldWidth;
                    const oldCenterX = oldLeft + (oldWidth / 2);

                    anchor.scaleToHeight(finalH);
                    const newWidth = anchor.getScaledWidth();

                    if (alignment === 'right') {
                        anchor.set('left', oldRight - newWidth);
                    } else if (alignment === 'left') {
                        anchor.set('left', oldLeft);
                    } else {
                        anchor.set('left', oldCenterX - (newWidth / 2));
                    }

                    // Position anchor at the top of the content block within the gap
                    // (The tags follow below it in the layout steps)
                    const totalNewBlockH = finalH + tagsH;
                    anchor.set('top', bestGap.top + 5);
                    anchor.setCoords();
                } else if (anchor.dataTag === 'title') {
                    // For title, just move to the gap, do not scale
                    anchor.set('top', bestGap.top + 5);
                    anchor.setCoords();
                }
            }
        }

        // 3. Anchor Blocked Area Constraints (Push out of blocked areas)
        let safety = 0;
        while (checkCollision(anchor, activeBlockedAreas, scaleFactor) && safety < 10) {
            const b = anchor.getBoundingRect();
            const area = activeBlockedAreas.find(a => {
                const aLeft = a.left * scaleFactor;
                const aTop = a.top * scaleFactor;
                const aWidth = a.width * scaleFactor;
                const aHeight = a.height * scaleFactor;
                return (b.left < aLeft + aWidth && b.left + b.width > aLeft &&
                    b.top < aTop + aHeight && b.top + b.height > aTop);
            });

            if (area) {
                const aLeft = area.left * scaleFactor;
                const aTop = area.top * scaleFactor;
                const aWidth = area.width * scaleFactor;
                const aHeight = area.height * scaleFactor;

                // Calculate overlaps
                const overL = (b.left + b.width) - aLeft;
                const overR = (aLeft + aWidth) - b.left;
                const overT = (b.top + b.height) - aTop;
                const overB = (aTop + aHeight) - b.top;

                // Find minimum push direction to exit the area
                const min = Math.min(overL, overR, overT, overB);

                if (min === overL) anchor.left -= overL;
                else if (min === overR) anchor.left += overR;
                else if (min === overT) anchor.top -= overT;
                else if (min === overB) anchor.top += overB;

                anchor.setCoords();
            }
            safety++;
        }
        anchor.setCoords();

        let current_y = anchor.top + anchor.getScaledHeight() + padding;

        const elements = canvas.getObjects().filter(o => {
            if (o === mainBg) return false; // Explicitly exclude mainBg
            if (o.dataTag === 'background') return false;
            if (o.dataTag === 'title') return false;
            if (o.dataTag === 'guide') return false;
            if (o.dataTag === 'fade_effect') return false;
            if (o.dataTag === 'grid_line') return false;
            if (o.dataTag === 'guide_overlay') return false;
            if (o.dataTag === 'ambilight_bg') return false;
            if (o.dataTag === 'separator') return false;
            if (o.dataTag === 'row_separator') return false;
            if (!o.dataTag) return false;

            // FIX: Ignore objects that have snapping disabled (Manual Mode)
            if (o.snapToObjects === false) return false;

            return true;
        });
        const rows = groupElementsByRow(elements, rowThreshold);

        if (rows.length > 0) {
            let maxRowWidth = 0;
            rows.forEach(row => {
                let w = 0;
                const visibleEls = row.filter(e => e.visible);
                visibleEls.forEach((el, i) => {
                    const pad = el.padding || 0;
                    w += el.getScaledWidth() + (pad * 2);
                    if (i < visibleEls.length - 1) w += hPadding;
                });
                if (w > maxRowWidth) maxRowWidth = w;
            });

            const anchorW = anchor.getScaledWidth();
            let shift = 0;

            if (alignment === 'center') {
                const idealStart = anchor.left + (anchorW - maxRowWidth) / 2;
                if (idealStart < marginLeft) shift = marginLeft - idealStart;
                else if (idealStart + maxRowWidth > canvas.width - marginRight) shift = (canvas.width - marginRight - maxRowWidth) - idealStart;
            } else if (alignment === 'right') {
                const idealStart = (anchor.left + anchorW) - maxRowWidth;
                if (idealStart < marginLeft) shift = marginLeft - idealStart;
            } else { // left
                const idealStart = anchor.left;
                if (idealStart + maxRowWidth > canvas.width - marginRight) shift = (canvas.width - marginRight - maxRowWidth) - idealStart;
            }

            if (shift !== 0) { anchor.set('left', anchor.left + shift); anchor.setCoords(); }
        }

        const anchorLeft = anchor.left;
        const anchorWidth = anchor.getScaledWidth();

        // Pre-calculate patterns to avoid creating them in the loop (Performance)
        let separatorPattern = null;
        if (separatorTextureImg) {
            separatorPattern = new fabric.Pattern({ source: separatorTextureImg, repeat: 'repeat' });
        }
        let rowSeparatorPattern = null;
        if (rowSeparatorTextureImg) {
            rowSeparatorPattern = new fabric.Pattern({ source: rowSeparatorTextureImg, repeat: 'repeat' });
        }

        // Track created separators to move them later if needed
        // const createdSeparators = []; // Not strictly needed unless we move them in step 3

        rows.forEach((row, rowIndex) => {
            // Auto-resize icons if enabled (Match Height)
            const resizableIcons = row.filter(el => el.type === 'image' && el.matchHeight && el.visible);
            if (resizableIcons.length > 0) {
                const ref = row.find(el => (el.type === 'i-text' || el.type === 'textbox' || el.type === 'group') && !el.matchHeight && el.visible);
                if (ref) {
                    const targetH = ref.getScaledHeight();
                    resizableIcons.forEach(icon => {
                        if (Math.abs(icon.getScaledHeight() - targetH) > 0.5) {
                            icon.scaleToHeight(targetH);
                            icon.setCoords();
                        }
                    });
                }
            }

            // Sort elements in this row by their X position (left to right)
            row.sort((a, b) => a.left - b.left);

            // Calculate total width of this row
            let totalRowWidth = 0;
            const visibleEls = row.filter(e => e.visible && e.getScaledWidth() > 0.1);
            visibleEls.forEach((el, index) => {
                el.setCoords(); // Ensure coords are fresh for width calc
                const pad = el.padding || 0;
                totalRowWidth += el.getScaledWidth() + (pad * 2);
                if (index < visibleEls.length - 1) totalRowWidth += hPadding;
            });

            // Determine starting X: Center relative to logo (even if wider), else align left
            let current_x;
            if (alignment === 'center') {
                current_x = anchorLeft + (anchorWidth - totalRowWidth) / 2;
            } else if (alignment === 'right') {
                current_x = (anchorLeft + anchorWidth) - totalRowWidth;
                // FIX: Shift right to align CONTENT edge to anchor (ignore padding of last element)
                const lastEl = visibleEls[visibleEls.length - 1];
                if (lastEl) current_x += (lastEl.padding || 0);
            } else {
                current_x = anchorLeft;
                // FIX: Shift left to align CONTENT edge to anchor (ignore padding of first element)
                const firstEl = visibleEls[0];
                if (firstEl) current_x -= (firstEl.padding || 0);
            }
            const rowStartX = current_x; // Capture start X for row separator centering

            // Ensure tags don't go off-screen (apply margins)
            if (current_x < marginLeft) current_x = marginLeft;
            if (current_x + totalRowWidth > canvas.width - marginRight) {
                current_x = Math.max(marginLeft, canvas.width - marginRight - totalRowWidth);
            }

            const maxRowHeight = Math.max(...row.map(el => el.visible ? el.getScaledHeight() + ((el.padding || 0) * 2) : 0));

            // FIX: Calculate max padding in this row to align all elements to a common baseline
            // This prevents elements with different padding (e.g. background box) from having different 'top' values,
            // which would cause them to be split into different rows on the next reload.
            const maxRowPadding = Math.max(...row.map(el => el.padding || 0));

            // Stack elements horizontally starting from the calculated current_x
            row.forEach(el => {
                const pad = el.padding || 0;
                // Align all elements to the same visual top line (current_y + maxRowPadding)
                // Elements with less padding will be visually aligned with elements that have more padding.
                el.set({
                    top: current_y + maxRowPadding,
                    left: current_x + (el.visible ? pad : 0) // FIX: Ignore padding for hidden elements to ensure strictly increasing 'left'
                });
                el.setCoords(); // Update coordinates for accurate width calculation

                // Collision Detection with Blocked Areas
                // If collision, push right until clear OR until limit reached
                const startX = current_x;
                let isColliding = el.visible ? checkCollision(el, activeBlockedAreas, scaleFactor) : false;

                while (isColliding && current_x < canvas.width - marginRight) {
                    current_x += 10;
                    el.set({ left: current_x + pad });
                    el.setCoords();
                    isColliding = checkCollision(el, activeBlockedAreas, scaleFactor);
                }
                // If still colliding (e.g. full width bar), reset X to preserve alignment and let vertical shift handle it
                if (isColliding) {
                    current_x = startX;
                    el.set({ left: current_x + pad });
                    el.setCoords();
                }

                if (el.visible) {
                    const elWidth = el.getScaledWidth() + (pad * 2);
                    current_x += elWidth + hPadding;

                    // Add Separator if configured and not the last visible element
                    const visIdx = visibleEls.indexOf(el);
                    if (separatorChar && visIdx > -1 && visIdx < visibleEls.length - 1) {
                        let fillVal = separatorColor;
                        if (separatorPattern) fillVal = separatorPattern;

                        const sep = new fabric.IText(separatorChar, {
                            fontFamily: (el.type === 'i-text' || el.type === 'textbox') ? el.fontFamily : 'Roboto',
                            fontSize: separatorSize,
                            fill: fillVal,
                            opacity: separatorOpacity,
                            selectable: false,
                            evented: false,
                            dataTag: 'separator',
                            originX: 'center',
                            originY: 'center',
                            shadow: (el.type === 'i-text' || el.type === 'textbox') ? el.shadow : null
                        });
                        // Position in the middle of the padding gap
                        sep.left = current_x - (hPadding / 2);
                        sep.top = el.top + (el.getScaledHeight() / 2);
                        canvas.add(sep);
                        // createdSeparators.push(sep);
                    }
                } else {
                    // Increment small amount to preserve order for next sort without visual gap
                    current_x += 0.01;
                }
            });

            // Check for right overflow and shift back if needed (prevent disappearing)
            const lastEl = row[row.length - 1];
            if (lastEl && lastEl.visible) {
                const rightEdge = lastEl.left + lastEl.getScaledWidth();
                const maxRight = canvas.width - marginRight;
                if (rightEdge > maxRight) {
                    const overflow = rightEdge - maxRight;
                    row.forEach(el => {
                        el.left -= overflow;
                        el.setCoords();
                    });
                }
            }

            // --- Row Separator Logic ---
            const isRowVisible = row.some(el => el.visible);
            let hasNextVisibleRow = false;
            for (let i = rowIndex + 1; i < rows.length; i++) {
                if (rows[i].some(e => e.visible)) {
                    hasNextVisibleRow = true;
                    break;
                }
            }

            if (rowSeparatorStyle && isRowVisible && hasNextVisibleRow) {
                const lineY = current_y + maxRowHeight + (padding / 2);
                let lineWidth = rowSeparatorWidth;
                if (rowSeparatorAutoWidth) lineWidth = totalRowWidth;

                let lineLeft;
                if (rowSeparatorAlign === 'left') {
                    lineLeft = rowStartX;
                } else if (rowSeparatorAlign === 'right') {
                    lineLeft = rowStartX + totalRowWidth - lineWidth;
                } else {
                    // Center
                    const centerX = rowStartX + (totalRowWidth / 2);
                    lineLeft = centerX - (lineWidth / 2);
                }

                let dashArray = null;
                if (rowSeparatorStyle === 'dotted') dashArray = [rowSeparatorThickness, rowSeparatorThickness];
                else if (rowSeparatorStyle === 'dashed') dashArray = [rowSeparatorThickness * 4, rowSeparatorThickness * 2];

                let strokeVal = rowSeparatorColor;
                if (rowSeparatorPattern) strokeVal = rowSeparatorPattern;

                const line = new fabric.Line([0, 0, lineWidth, 0], {
                    left: lineLeft,
                    top: lineY,
                    stroke: strokeVal,
                    opacity: rowSeparatorOpacity,
                    strokeWidth: rowSeparatorThickness,
                    strokeDashArray: dashArray,
                    selectable: false,
                    evented: false,
                    dataTag: 'row_separator',
                    originY: 'center'
                });
                canvas.add(line);
            }

            if (maxRowHeight > 0) {
                current_y += maxRowHeight + padding;
            } else {
                current_y += 5; // Maintain small vertical separation for hidden rows to prevent merging
            }
        });

        // Check for bottom overflow and shift up if necessary
        const contentBottom = current_y - padding;
        const maxBottom = canvas.height - marginBottom;

        // Determine the full horizontal range of the layout block
        const allElements = [anchor];
        rows.forEach(row => row.forEach(el => { if (el.visible) allElements.push(el); }));

        let blockLeft = anchor.left;
        let blockRight = anchor.left + anchor.getScaledWidth();
        allElements.forEach(el => {
            const b = el.getBoundingRect();
            if (b.left < blockLeft) blockLeft = b.left;
            if (b.left + b.width > blockRight) blockRight = b.left + b.width;
        });

        let maxBlockedShiftUp = 0;
        let maxBlockedShiftDown = 0;

        allElements.forEach(el => {
            const b = el.getBoundingRect();
            activeBlockedAreas.forEach(area => {
                const aLeft = area.left * scaleFactor;
                const aTop = area.top * scaleFactor;
                const aWidth = area.width * scaleFactor;
                const aHeight = area.height * scaleFactor;

                if (b.left < aLeft + aWidth && b.left + b.width > aLeft &&
                    b.top < aTop + aHeight && b.top + b.height > aTop) {

                    const areaCenterY = aTop + (aHeight / 2);
                    const canvasCenterY = canvas.height / 2;

                    if (areaCenterY > canvasCenterY) {
                        const overlap = (b.top + b.height) - aTop;
                        if (overlap > 0 && overlap > maxBlockedShiftUp) maxBlockedShiftUp = overlap;
                    } else {
                        const overlap = (aTop + aHeight) - b.top;
                        if (overlap > 0 && overlap > maxBlockedShiftDown) maxBlockedShiftDown = overlap;
                    }
                }
            });
        });

        // 4. Resolve Conflicts (Unified logic)
        if (maxBlockedShiftDown > 0 || maxBlockedShiftUp > 0 || contentBottom > maxBottom) {
            if (retryCount > 10) return;

            // Calculate current constraints
            let limitTop = marginTop;
            let limitBottom = maxBottom;

            activeBlockedAreas.forEach(area => {
                const aLeft = area.left * scaleFactor;
                const aWidth = area.width * scaleFactor;
                const aRight = aLeft + aWidth;
                const aTop = area.top * scaleFactor;
                const aHeight = area.height * scaleFactor;
                const aBottom = aTop + aHeight;

                // Robust: Check horizontal intersection with ANY part of the layout block
                if (aLeft < blockRight && aRight > blockLeft) {
                    if (aBottom <= anchor.top + 10) { // Area is above
                        if (aBottom > limitTop) limitTop = aBottom;
                    } else if (aTop >= (current_y - padding - 10)) { // Area is below
                        if (aTop < limitBottom) limitBottom = aTop;
                    }
                }
            });

            const availableH = limitBottom - limitTop;
            const contentH = contentBottom - anchor.top;
            const totalShiftNeeded = Math.max(0, (contentBottom - limitBottom), maxBlockedShiftUp);

            // CASE A: Pinned or too large -> Shrink
            if (maxBlockedShiftDown > 0 && maxBlockedShiftUp > 0 || (contentH > availableH)) {
                const deficit = contentH - availableH;
                const currentAnchorH = anchor.getScaledHeight();
                const newAnchorH = Math.max(20, currentAnchorH - deficit - 5);

                const oldCenterX = anchor.left + (anchor.getScaledWidth() / 2);
                const oldRight = anchor.left + anchor.getScaledWidth();

                anchor.scaleToHeight(newAnchorH);

                if (alignment === 'center') anchor.set('left', oldCenterX - (anchor.getScaledWidth() / 2));
                else if (alignment === 'right') anchor.set('left', oldRight - anchor.getScaledWidth());

                anchor.set('top', limitTop);
                return updateVerticalLayout(skipRender, retryCount + 1);
            }
            // CASE B: Hit Top obstacle (move down)
            else if (maxBlockedShiftDown > 0) {
                anchor.top += maxBlockedShiftDown;
                return updateVerticalLayout(skipRender, retryCount + 1);
            }
            // CASE C: Hit Bottom obstacle or Margin (move up)
            else if (totalShiftNeeded > 0) {
                const safeShiftUp = Math.max(0, anchor.top - limitTop);
                if (totalShiftNeeded > safeShiftUp) {
                    // Cannot shift enough, must shrink deficit
                    const deficit = totalShiftNeeded - safeShiftUp;
                    const oldCenterX = anchor.left + (anchor.getScaledWidth() / 2);
                    const oldRight = anchor.left + anchor.getScaledWidth();

                    anchor.scaleToHeight(anchor.getScaledHeight() - deficit);

                    if (alignment === 'center') anchor.set('left', oldCenterX - (anchor.getScaledWidth() / 2));
                    else if (alignment === 'right') anchor.set('left', oldRight - anchor.getScaledWidth());

                    anchor.set('top', limitTop);
                } else {
                    anchor.top -= totalShiftNeeded;
                }
                return updateVerticalLayout(skipRender, retryCount + 1);
            }
            return;
        }

        canvas.getObjects().forEach(o => o.setCoords());
        if (!skipRender) canvas.requestRenderAll();
    });
}

function toggleFullscreen() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!document.fullscreenElement) {
        wrapper.requestFullscreen().catch(err => console.log(err));
    } else {
        document.exitFullscreen();
    }
}

function toggleGrid() {
    gridEnabled = !gridEnabled;
    if (gridEnabled) drawGrid();
    else removeGrid();
    canvas.requestRenderAll();
}

function drawGrid() {
    removeGrid();
    const w = canvas.width, h = canvas.height;
    const opts = { stroke: '#555', strokeDashArray: [5, 5], selectable: false, evented: false, dataTag: 'grid_line' };
    for (let i = 1; i < (w / gridSize); i++) canvas.add(new fabric.Line([i * gridSize, 0, i * gridSize, h], opts));
    for (let i = 1; i < (h / gridSize); i++) canvas.add(new fabric.Line([0, i * gridSize, w, i * gridSize], opts));

    const gridLines = canvas.getObjects().filter(o => o.dataTag === 'grid_line');
    const fadeObjs = canvas.getObjects().filter(o => o.dataTag === 'fade_effect');

    gridLines.forEach(o => canvas.sendToBack(o));
    fadeObjs.forEach(o => canvas.sendToBack(o));
    if (mainBg) canvas.sendToBack(mainBg);
    enforceLayering();
}

function drawGuide(x1, y1, x2, y2) {
    const l = new fabric.Line([x1, y1, x2, y2], { stroke: 'cyan', strokeWidth: 1, strokeDashArray: [4, 4], selectable: false, evented: false, dataTag: 'guide' });
    canvas.add(l); guideLines.push(l);
}
function clearGuides() { guideLines.forEach(l => canvas.remove(l)); guideLines = []; }

function removeGrid() {
    const gridLines = canvas.getObjects().filter(o => o.dataTag === 'grid_line');
    gridLines.forEach(o => canvas.remove(o));
}

function init() {
    closePreviewPopup(); // Explicitly hide popup on load to prevent state issues
    restoreSidebarState();

    // Restore active tab
    const savedTab = localStorage.getItem('active_tab');
    if (savedTab) {
        const tabLink = document.querySelector(`.tab-link[onclick*="'${savedTab}'"]`);
        if (tabLink) {
            openTab({ currentTarget: tabLink }, savedTab);
            if (savedTab === 'gallery-tab' && typeof loadGallery === 'function') loadGallery();
            else if (savedTab === 'layouts-tab' && typeof loadLayoutsList === 'function') loadLayoutsList();
            else if (savedTab === 'batch-tab' && typeof loadBatchLayouts === 'function') loadBatchLayouts();
            else if (savedTab === 'font-tab' && typeof loadFontManager === 'function') loadFontManager();
        }
    }

    // Load saved resolution preference
    const savedRes = localStorage.getItem('editor_resolution');
    if (savedRes) {
        const resSelect = document.getElementById('resSelect');
        if (resSelect) resSelect.value = savedRes;
    }
    const currentRes = document.getElementById('resSelect') ? document.getElementById('resSelect').value : '1080';
    const initW = (currentRes === '2160') ? 3840 : 1920;
    const initH = (currentRes === '2160') ? 2160 : 1080;

    canvas = new fabric.Canvas('mainCanvas', { width: initW, height: initH, backgroundColor: '#000000', preserveObjectStacking: true });
    canvas.renderOnAddRemove = false;
    fabric.Object.prototype.objectCaching = true;

    // Optimize handles for touch devices
    if (window.innerWidth < 1024) {
        fabric.Object.prototype.cornerSize = 70;
        fabric.Object.prototype.touchCornerSize = 70;
        fabric.Object.prototype.cornerStyle = 'circle';
        fabric.Object.prototype.transparentCorners = false;
        fabric.Object.prototype.borderScaleFactor = 2;
    }

    canvas.on('object:scaling', (e) => {
        const t = e.target;
        if (t instanceof fabric.Textbox) {
            const res = document.getElementById('resSelect') ? document.getElementById('resSelect').value : '1080';
            const resScale = (res === '2160') ? 2 : 1;

            t.set({ width: (t.width * t.scaleX) / resScale, fixedHeight: (t.height * t.scaleY) / resScale, scaleX: resScale, scaleY: resScale });
            if (t.dataTag === 'overview') {
                if (resizeRaf) cancelAnimationFrame(resizeRaf);
                resizeRaf = requestAnimationFrame(() => fitTextToContainer(t));
            }
        }
        if (t.dataTag === 'title' && t.type === 'image') {
            preferredLogoWidth = t.getScaledWidth();
            // Update slot dimensions to match the new visual size
            t.slotWidth = t.getScaledWidth();
            t.slotHeight = t.getScaledHeight();
        }
        if (t === mainBg) updateFades();

        if (layoutDebounceTimer) clearTimeout(layoutDebounceTimer);
        layoutDebounceTimer = setTimeout(() => updateVerticalLayout(), 50);

        canvas.requestRenderAll();
    });

    canvas.on('mouse:down', (e) => {
        const active = e.target;
        if (!active || !active.selectable || active === mainBg) return;
        snapLines = { v: [], h: [] };

        const snapToObjects = active.snapToObjects !== false;

        if (snapToObjects) {
            canvas.getObjects().forEach(obj => {
                if (obj === active || !obj.selectable || !obj.visible || obj.dataTag === 'guide') return;
                const b = obj.getBoundingRect();
                snapLines.h.push(b.top, b.top + b.height, b.top + b.height / 2);
                snapLines.v.push(b.left, b.left + b.width, b.left + b.width / 2);
            });
        }
    });

    canvas.on('object:moving', (e) => {
        const active = e.target;
        if (active === mainBg) { updateFades(); return; }

        // 1. Grid Snapping (Always Active if enabled)
        if (gridEnabled) {
            active.set({
                left: Math.round(active.left / gridSize) * gridSize,
                top: Math.round(active.top / gridSize) * gridSize
            });
        }

        // 2. Object Snapping (Conditional)
        const snapToObjects = active.snapToObjects !== false;

        clearGuides();

        if (snapToObjects) {
            const threshold = 10;
            const b = active.getBoundingRect();
            const pts = { x: [b.left, b.left + b.width, b.left + b.width / 2], y: [b.top, b.top + b.height, b.top + b.height / 2] };

            for (const line of snapLines.v) {
                for (const pt of pts.x) {
                    if (Math.abs(pt - line) < threshold) {
                        active.set({ left: active.left + (line - pt) });
                        drawGuide(line, 0, line, canvas.height);
                        canvas.requestRenderAll();
                        return;
                    }
                }
            }
            for (const line of snapLines.h) {
                for (const pt of pts.y) {
                    if (Math.abs(pt - line) < threshold) {
                        active.set({ top: active.top + (line - pt) });
                        drawGuide(0, line, canvas.width, line);
                        canvas.requestRenderAll();
                        return;
                    }
                }
            }
        }

        // Live layout update for dynamic resizing feedback while dragging
        if (layoutDebounceTimer) clearTimeout(layoutDebounceTimer);
        layoutDebounceTimer = setTimeout(() => updateVerticalLayout(), 10);
    });

    canvas.on('mouse:up', () => {
        try {
            clearGuides();
        } catch (err) { console.error("Error in mouse:up", err); }
    });

    canvas.on('selection:created', updateSelectionUI);
    canvas.on('selection:updated', updateSelectionUI);
    canvas.on('selection:cleared', updateSelectionUI);

    canvas.on('object:modified', () => {
        updateVerticalLayout();
        saveToLocalStorage();
    });
    canvas.on('object:added', saveToLocalStorage);
    canvas.on('object:removed', saveToLocalStorage);
    canvas.on('text:changed', saveToLocalStorage);

    window.addEventListener('keydown', (e) => {
        // CRITICAL FIX: Ignore nudging if user is typing in an input
        const tag = document.activeElement.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

        // Undo / Redo Shortcuts
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo();
            else undo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            redo();
            return;
        }

        const active = canvas.getActiveObject();
        if (!active || (active.isEditing)) return;

        if (e.key === "Delete" || e.key === "Backspace") {
            canvas.getActiveObjects().forEach(obj => { if (obj === mainBg) mainBg = null; canvas.remove(obj); });
            canvas.discardActiveObject().requestRenderAll();
            return;
        }

        // Smart Nudging
        const step = e.shiftKey ? 10 : 1;
        let moved = false;
        if (e.key === 'ArrowLeft') { active.left -= step; moved = true; }
        else if (e.key === 'ArrowRight') { active.left += step; moved = true; }
        else if (e.key === 'ArrowUp') { active.top -= step; moved = true; }
        else if (e.key === 'ArrowDown') { active.top += step; moved = true; }

        if (moved) {
            e.preventDefault();
            active.setCoords();
            updateVerticalLayout();
            canvas.requestRenderAll();
            saveToLocalStorage();
        }
    });

    // Touch Gestures (Pull-to-Refresh)
    let touchStartY = 0;
    let touchStartX = 0;
    const refreshIndicator = document.createElement('div');
    refreshIndicator.id = 'pullRefreshIndicator';
    refreshIndicator.innerText = '⬇️ Pull to Refresh';
    document.body.appendChild(refreshIndicator);

    window.addEventListener('touchstart', e => {
        // Only allow pull-to-refresh from the header (.nav-tabs)
        // And explicitly exclude the menu container inside it
        if (!e.target.closest('.nav-tabs') || e.target.closest('.nav-links-container')) {
            touchStartY = -1; // Disable gesture tracking
            return;
        }
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
    }, { passive: true });

    window.addEventListener('touchmove', e => {
        if (touchStartY < 0) return; // Gesture tracking disabled

        if (!document.fullscreenElement && window.scrollY === 0) {
            const touchY = e.touches[0].clientY;
            const diffY = touchY - touchStartY;
            const threshold = window.innerHeight / 2;

            if (diffY > 50) {
                refreshIndicator.style.display = 'flex';
                refreshIndicator.style.opacity = Math.min(diffY / threshold, 1);

                if (diffY > threshold) {
                    refreshIndicator.innerText = '🔄 Release to Refresh';
                    refreshIndicator.style.background = 'rgba(46, 125, 50, 0.9)'; // Green
                    refreshIndicator.classList.add('pulse-green');
                } else {
                    refreshIndicator.innerText = '⬇️ Pull further...';
                    refreshIndicator.style.background = 'rgba(0, 0, 0, 0.8)';
                    refreshIndicator.classList.remove('pulse-green');
                }
            }
        }
    }, { passive: true });

    window.addEventListener('touchend', e => {
        if (touchStartY < 0) return; // Gesture tracking disabled

        const touchEndY = e.changedTouches[0].clientY;
        const touchEndX = e.changedTouches[0].clientX;
        const diffY = touchEndY - touchStartY;
        const diffX = touchEndX - touchStartX;
        const threshold = window.innerHeight / 2;

        refreshIndicator.style.display = 'none';

        // Check conditions:
        // 1. Not in fullscreen
        // 2. Scrolled to top
        // 3. Swipe down > 50% of screen height
        if (!document.fullscreenElement && window.scrollY === 0 && diffY > threshold) {
            location.reload();
        }
    }, { passive: true });

    if (!loadFromLocalStorage()) {
        if (window.initialBackdropUrl) loadBackground(window.initialBackdropUrl);
    }

    // Enable font previews in dropdown
    const fontSelect = document.getElementById('fontFamilySelect');
    if (fontSelect) {
        const setFont = (opt) => { if (opt.value) opt.style.fontFamily = opt.value; };
        Array.from(fontSelect.options).forEach(setFont);
        new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
            if (n.tagName === 'OPTION') setFont(n);
            if (n.tagName === 'OPTGROUP') Array.from(n.children).forEach(setFont);
        }))).observe(fontSelect, { childList: true, subtree: true });
    }

    loadOverlayProfiles();
    loadTextureProfiles();
    loadFonts();
    loadCustomIcons();
    updateFadeControls();
    loadCronJobs(); // Load jobs on init
    injectCronFilterUI(); // Inject filter UI for Cron Jobs
    updateCronFrequencyOptions(); // Inject extra frequency options

    // Restore shuffle provider preference
    const shuffleSel = document.getElementById('shuffleProvider');
    if (shuffleSel) {
        try {
            const saved = localStorage.getItem('tvb_shuffle_provider');
            if (saved && Array.from(shuffleSel.options).some(o => o.value === saved)) {
                shuffleSel.value = saved;
            }
        } catch (e) {}
    }

    // Set initial mobile title
    const activeLink = document.querySelector('.tab-link.active');
    if (activeLink) {
        const mobileTitle = document.getElementById('mobile-header-title');
        if (mobileTitle) mobileTitle.innerText = activeLink.innerText;
    }

    // Initial History Save
    saveHistory();
    checkUpdate();
}

function checkUpdate() {
    const versionEl = document.getElementById('versionDisplay');
    if (!versionEl) return;

    const installedVer = versionEl.getAttribute('data-installed') || "1.0.0";

    fetch('https://api.github.com/repos/z9m/androidtvbackgroundWebGui/tags')
        .then(res => res.json())
        .then(data => {
            if (data && data.length > 0) {
                const latestTag = data[0].name.replace('v', '');
                const currentTag = installedVer.replace('v', '');
                if (latestTag !== currentTag) {
                    versionEl.innerHTML = `v${installedVer} <span style="margin-left:5px;">⚠️ Update: v${latestTag}</span>`;
                    versionEl.classList.add('update-available');
                    versionEl.title = "Click to download new version";
                    versionEl.href = "https://hub.docker.com/repository/docker/butch708/tv-background-suite/tags";
                } else {
                    versionEl.innerText = `v${installedVer} (Latest)`;
                    versionEl.style.color = "#4caf50";
                }
            }
        }).catch(err => console.log('Update check failed', err));
}

function jumpToHistory(index) {
    index = parseInt(index);
    if (isNaN(index) || index < 0 || index >= undoStack.length - 1) return;

    isUndoRedoProcessing = true;

    // Move states from undoStack to redoStack until we reach the target index
    while (undoStack.length - 1 > index) {
        const current = undoStack.pop();
        redoStack.push(current);
    }

    const target = undoStack[undoStack.length - 1];
    restoreState(JSON.parse(target.data));

    const sel = document.getElementById('historySelect');
    if (sel) sel.value = "";
}

function saveHistory(force = false) {
    if (isUndoRedoProcessing || !canvas) return;

    const json = canvas.toJSON(['dataTag', 'fullMediaText', 'selectable', 'evented', 'lockScalingY', 'splitByGrapheme', 'fixedHeight', 'editable', 'matchHeight', 'autoBackgroundColor', 'textureId', 'textureScale', 'textureRotation', 'textureOpacity', 'snapToObjects', 'logoAutoFix', 'maxItems', 'fullList', 'slotWidth', 'slotHeight']);

    // Filter out fade effects and grid lines (same as saveToLocalStorage)
    json.objects = json.objects.filter(o => o.dataTag !== 'fade_effect' && o.dataTag !== 'grid_line' && o.dataTag !== 'guide_overlay' && o.dataTag !== 'guide' && o.dataTag !== 'ambilight_bg' && o.dataTag !== 'separator' && o.dataTag !== 'row_separator');

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

    // Save blocked areas to JSON so render_task.js can use them
    const overlayId = document.getElementById('overlaySelect').value;
    if (overlayId) {
        const profile = overlayProfiles.find(p => p.id === overlayId);
        if (profile && profile.blocked_areas) {
            json.custom_effects.blocked_areas = profile.blocked_areas;
        }
    }

    json.lastFetchedData = lastFetchedData;

    const stateStr = JSON.stringify(json);
    if (!force && undoStack.length > 0 && undoStack[undoStack.length - 1].data === stateStr) return;

    undoStack.push({
        data: stateStr,
        time: new Date().toLocaleTimeString()
    });

    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];

    updateUndoRedoUI();
}

function undo() {
    if (undoStack.length <= 1) return;

    isUndoRedoProcessing = true;

    const current = undoStack.pop();
    redoStack.push(current);

    const previous = undoStack[undoStack.length - 1];
    restoreState(JSON.parse(previous.data));
}

function redo() {
    if (redoStack.length === 0) return;

    isUndoRedoProcessing = true;

    const next = redoStack.pop();
    undoStack.push(next);

    restoreState(JSON.parse(next.data));
}

function restoreState(data) {
    canvas.loadFromJSON(data, () => {
        lastFetchedData = data.lastFetchedData || null;
        mainBg = canvas.getObjects().find(o => o.dataTag === 'background');

        // Fallback if not tagged
        if (!mainBg && canvas.getObjects().length > 0) {
            const firstObj = canvas.item(0);
            if (firstObj && firstObj.type === 'image' && firstObj.width > 500) {
                mainBg = firstObj;
                mainBg.set('dataTag', 'background');
            }
        }

        if (data.custom_effects) applyCustomEffects(data.custom_effects);
        else updateFades();

        canvas.renderAll();
        updateVerticalLayout();
        saveToLocalStorage(); // This triggers saveHistory, but isUndoRedoProcessing blocks it

        isUndoRedoProcessing = false;
        updateUndoRedoUI();
    }, (o, object) => {
        // --- FIX: State Synchronization & Gradient Restoration ---
        if (object.fill && object.fill.type === 'linear' && object.fill.colorStops && object.fill.colorStops.length > 0) {
            try {
                if (object.dataTag === 'fade_effect') {
                    // 1. EXTRACT COLOR FROM JSON
                    let loadedColor = "#000000";
                    let rawColor = object.fill.colorStops[0].color;

                    if (rawColor && rawColor.startsWith('rgb')) {
                        const rgb = rawColor.match(/\d+/g);
                        if (rgb && rgb.length >= 3) {
                            loadedColor = "#" +
                                ("0" + parseInt(rgb[0], 10).toString(16)).slice(-2) +
                                ("0" + parseInt(rgb[1], 10).toString(16)).slice(-2) +
                                ("0" + parseInt(rgb[2], 10).toString(16)).slice(-2);
                        }
                    } else if (rawColor && rawColor.startsWith('#')) {
                        loadedColor = rawColor;
                    }

                    // 2. SYNC UI TO JSON COLOR
                    const picker = document.getElementById('bgColor');
                    if (picker && loadedColor && picker.value.toLowerCase() !== loadedColor.toLowerCase()) {
                        picker.value = loadedColor;
                    }
                }
                // 3. RE-APPLY GRADIENT (Fabric.js Fix)
                const freshStops = object.fill.colorStops.map(stop => ({
                    offset: stop.offset,
                    color: stop.color
                }));
                object.fill.colorStops = freshStops;
                object.dirty = true;
            } catch (e) {
                console.warn("Failed to restore gradient for object:", object, e);
            }
        }
    });
}

function updateUndoRedoUI() {
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    const historySelect = document.getElementById('historySelect');

    if (btnUndo) {
        btnUndo.disabled = undoStack.length <= 1;
        btnUndo.style.opacity = undoStack.length <= 1 ? '0.5' : '1';
        btnUndo.style.cursor = undoStack.length <= 1 ? 'default' : 'pointer';
    }
    if (btnRedo) {
        btnRedo.disabled = redoStack.length === 0;
        btnRedo.style.opacity = redoStack.length === 0 ? '0.5' : '1';
        btnRedo.style.cursor = redoStack.length === 0 ? 'default' : 'pointer';
    }

    if (historySelect) {
        historySelect.innerHTML = '<option value="" disabled selected>🕒</option>';
        // Populate history (reverse order, excluding current tip)
        for (let i = undoStack.length - 2; i >= 0; i--) {
            const opt = document.createElement('option');
            opt.value = i;
            const steps = undoStack.length - 1 - i;
            opt.innerText = `↩ ${steps} (${undoStack[i].time})`;
            historySelect.appendChild(opt);
        }
        historySelect.disabled = undoStack.length <= 1;
    }
}

function applyCustomEffects(eff) {
    // Restore Background Mode first to ensure options are populated before setting fadeEffect
    if (eff.backgroundMode) {
        backgroundMode = eff.backgroundMode;
        const bgModeSel = document.getElementById('bgStyleSelect');
        if (bgModeSel) bgModeSel.value = backgroundMode;
        populateFadeEffectOptions(backgroundMode);
    }

    if (eff.bgColor) {
        document.getElementById('bgColor').value = eff.bgColor;
        canvas.setBackgroundColor(eff.bgColor, () => { updateFades(); });
    }
    if (eff.bgBrightness) document.getElementById('bgBrightness').value = eff.bgBrightness;
    if (eff.fadeEffect) document.getElementById('fadeEffect').value = eff.fadeEffect;
    if (eff.fadeRadius) document.getElementById('fadeRadius').value = eff.fadeRadius;
    if (eff.fadeSoftness) {
        const el = document.getElementById('fadeSoftness');
        if (el) {
            el.value = eff.fadeSoftness;
            document.getElementById('fadeSoftnessVal').innerText = eff.fadeSoftness;
        }
    }
    if (eff.fadeLeft) document.getElementById('fadeLeft').value = eff.fadeLeft;
    if (eff.fadeRight) document.getElementById('fadeRight').value = eff.fadeRight;
    if (eff.fadeTop) document.getElementById('fadeTop').value = eff.fadeTop;
    if (eff.fadeBottom) document.getElementById('fadeBottom').value = eff.fadeBottom;
    if (eff.tagAlignment) document.getElementById('tagAlignSelect').value = eff.tagAlignment;
    else if (eff.centerTags !== undefined) document.getElementById('tagAlignSelect').value = eff.centerTags ? 'center' : 'left';
    if (eff.tagPadding) {
        const el = document.getElementById('tagPaddingInput');
        if (el) {
            el.value = eff.tagPadding;
            const valEl = document.getElementById('tagPaddingVal');
            if (valEl) valEl.innerText = eff.tagPadding + "px";
        }
    }
    if (eff.lineSpacing) {
        const el = document.getElementById('lineSpacingInput');
        if (el) {
            el.value = eff.lineSpacing;
            const valEl = document.getElementById('lineSpacingVal');
            if (valEl) valEl.innerText = eff.lineSpacing + "px";
        }
    }
    if (eff.tagSeparator !== undefined) {
        const el = document.getElementById('tagSeparatorInput');
        if (el) el.value = eff.tagSeparator;
    }
    if (eff.tagSeparatorSize) {
        const el = document.getElementById('tagSeparatorSizeInput');
        if (el) {
            el.value = eff.tagSeparatorSize;
            document.getElementById('tagSeparatorSizeVal').innerText = eff.tagSeparatorSize + "px";
        }
    }
    if (eff.tagSeparatorColor) {
        const el = document.getElementById('tagSeparatorColorInput');
        if (el) el.value = eff.tagSeparatorColor;
    }
    if (eff.tagSeparatorOpacity !== undefined) {
        const el = document.getElementById('tagSeparatorOpacityInput');
        if (el) {
            el.value = eff.tagSeparatorOpacity;
            document.getElementById('tagSeparatorOpacityVal').innerText = eff.tagSeparatorOpacity + "%";
        }
    }
    if (eff.tagSeparatorTexture !== undefined) {
        const el = document.getElementById('tagSeparatorTextureSelect');
        if (el) {
            el.value = eff.tagSeparatorTexture;
            updateSeparatorTexture(); // Load the texture
        }
    }
    if (eff.rowSeparatorStyle !== undefined) {
        const el = document.getElementById('rowSeparatorStyle');
        if (el) el.value = eff.rowSeparatorStyle;
    }
    if (eff.rowSeparatorThickness) {
        const el = document.getElementById('rowSeparatorThickness');
        if (el) {
            el.value = eff.rowSeparatorThickness;
            document.getElementById('rowSeparatorThicknessVal').innerText = eff.rowSeparatorThickness + "px";
        }
    }
    if (eff.rowSeparatorColor) {
        const el = document.getElementById('rowSeparatorColor');
        if (el) el.value = eff.rowSeparatorColor;
    }
    if (eff.rowSeparatorTexture !== undefined) {
        const el = document.getElementById('rowSeparatorTextureSelect');
        if (el) {
            el.value = eff.rowSeparatorTexture;
            updateRowSeparatorTexture();
        }
    }
    if (eff.rowSeparatorOpacity !== undefined) {
        const el = document.getElementById('rowSeparatorOpacityInput');
        if (el) {
            el.value = eff.rowSeparatorOpacity;
            document.getElementById('rowSeparatorOpacityVal').innerText = eff.rowSeparatorOpacity + "%";
        }
    }
    if (eff.rowSeparatorAlign) {
        const el = document.getElementById('rowSeparatorAlign');
        if (el) el.value = eff.rowSeparatorAlign;
    }
    if (eff.rowSeparatorAutoWidth !== undefined) {
        const el = document.getElementById('rowSeparatorAutoWidth');
        if (el) el.checked = eff.rowSeparatorAutoWidth;
        toggleRowSeparatorWidthControl();
    }
    if (eff.rowSeparatorWidth) {
        const el = document.getElementById('rowSeparatorWidth');
        if (el) {
            el.value = eff.rowSeparatorWidth;
            document.getElementById('rowSeparatorWidthVal').innerText = eff.rowSeparatorWidth + "px";
        }
    }
    if (eff.textContentAlignment) document.getElementById('textContentAlignSelect').value = eff.textContentAlignment;
    if (eff.limitGenres !== undefined) {
        const val = eff.limitGenres ? 2 : 6;
        document.getElementById('genreLimitSlider').value = val;
        document.getElementById('genreLimitVal').innerText = (val == 6) ? "Max" : val;
    }
    if (eff.genreLimit !== undefined) {
        document.getElementById('genreLimitSlider').value = eff.genreLimit;
        document.getElementById('genreLimitVal').innerText = (eff.genreLimit == 6) ? "Max" : eff.genreLimit;
    }
    if (eff.overlayId) {
        const sel = document.getElementById('overlaySelect');
        if (sel && sel.options.length > 1) {
            sel.value = eff.overlayId;
            updateOverlay();
        } else {
            window.restoredOverlayId = eff.overlayId;
        }
    }
    if (eff.logoAutoFix !== undefined) {
        const batchCheck = document.getElementById('batchLogoAutoFix');
        if (batchCheck) batchCheck.checked = eff.logoAutoFix;
    }
    if (eff.margins) {
        document.getElementById('marginTopInput').value = eff.margins.top || 50;
        document.getElementById('marginBottomInput').value = eff.margins.bottom || 50;
        document.getElementById('marginLeftInput').value = eff.margins.left || 50;
        document.getElementById('marginRightInput').value = eff.margins.right || 50;
    }
    // updateFadeControls(); // Removed here, called after bg set or via updateFades inside callback
}

function loadBackground(url, skipRender = false, restoredState = null) {
    return new Promise((resolve) => {
        const proxiedUrl = url.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(url)}` : url;
        fabric.Image.fromURL(proxiedUrl, function (img, isError) {
            if (isError || !img || img.width === 0 || img.height === 0) { console.warn("Failed to load background:", url); resolve(); return; }

            // --- FIX: Enforce Fixed Canvas Resolution ---
            // We determine the target resolution based on user selection (1080p or 4K).
            // This prevents the canvas from shrinking if the source image is low-res (e.g. 720p).
            const currentRes = document.getElementById('resSelect') ? document.getElementById('resSelect').value : '1080';
            const targetW = (currentRes === '2160') ? 3840 : 1920;
            const targetH = (currentRes === '2160') ? 2160 : 1080;

            // Ensure canvas dimensions are strictly set to target
            if (canvas.getWidth() !== targetW || canvas.getHeight() !== targetH) {
                canvas.setDimensions({ width: targetW, height: targetH });
            }

            // Default: "Cover" Scaling Logic
            let scale = Math.max(targetW / img.width, targetH / img.height);
            let left = targetW / 2;
            let top = targetH / 2;
            let flipX = false;
            let flipY = false;

            // Check for existing background to preserve state
            const oldBg = canvas.getObjects().find(o => o.dataTag === 'background');

            if (restoredState) {
                left = restoredState.left;
                top = restoredState.top;
                flipX = restoredState.flipX;
                flipY = restoredState.flipY;

                if (restoredState.originX !== 'center') left += (restoredState.width * restoredState.scaleX) / 2;
                if (restoredState.originY !== 'center') top += (restoredState.height * restoredState.scaleY) / 2;

                if (img.width > 0) {
                    scale = (restoredState.width * restoredState.scaleX) / img.width;
                }
                if (oldBg) canvas.remove(oldBg);
            } else if (oldBg) {
                const center = oldBg.getCenterPoint();
                left = center.x;
                top = center.y;
                flipX = oldBg.flipX;
                flipY = oldBg.flipY;

                // Preserve visual size
                if (img.width > 0) {
                    scale = oldBg.getScaledWidth() / img.width;
                }
                canvas.remove(oldBg);
            } else {
                if (canvas.backgroundImage) canvas.setBackgroundImage(null, canvas.renderAll.bind(canvas));
            }

            img.set({
                left: left,
                top: top,
                originX: 'center',      // Set origin to center for proper scaling
                originY: 'center',
                scaleX: scale,
                scaleY: scale,
                flipX: flipX,
                flipY: flipY,
                dataTag: 'background',
                selectable: true,
                evented: true
            });

            // Add new background and send to back
            canvas.add(img);
            canvas.sendToBack(img);
            mainBg = img;

            // Re-apply gradient overlay if it exists (fixes stacking order)
            const fade = canvas.getObjects().find(o => o.dataTag === 'fade_effect');
            if (fade) canvas.bringToFront(fade);

            // --- FIX: Re-align Layout ---
            // Since canvas dimensions might have been reset, we must force a layout update.
            // This ensures right-aligned tags sit correctly at the 1920px/3840px edge.
            if (typeof updateVerticalLayout === 'function') {
                updateVerticalLayout();
            }

            updateFades(skipRender);
            canvas.requestRenderAll();
            resolve();
            saveToLocalStorage();
        }, { crossOrigin: 'anonymous' });
    });
}

function updateFadeControls() {
    const type = document.getElementById('fadeEffect').value;
    const show = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'block'; };
    const hide = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
    const radiusLabel = document.querySelector('label[for="fadeRadius"]');

    ['ctrl-fade-radius', 'ctrl-fade-left', 'ctrl-fade-right', 'ctrl-fade-top', 'ctrl-fade-bottom'].forEach(show);
    // Hide softness by default (only for specific ambilight modes)
    hide('ctrl-fade-softness');

    if (backgroundMode === 'solid') {
        if (type === 'custom') {
            hide('ctrl-fade-radius');
        } else if (type === 'bottom-left') {
            hide('ctrl-fade-top'); hide('ctrl-fade-right'); radiusLabel.innerText = "Corner Radius";
        } else if (type === 'bottom-right') {
            hide('ctrl-fade-top'); hide('ctrl-fade-left'); radiusLabel.innerText = "Corner Radius";
        } else if (type === 'top-left') {
            hide('ctrl-fade-bottom'); hide('ctrl-fade-right'); radiusLabel.innerText = "Corner Radius";
        } else if (type === 'top-right') {
            hide('ctrl-fade-bottom'); hide('ctrl-fade-left'); radiusLabel.innerText = "Corner Radius";
        } else if (type === 'vignette') {
            hide('ctrl-fade-left'); hide('ctrl-fade-right'); show('ctrl-fade-top'); show('ctrl-fade-bottom');
            radiusLabel.innerText = "Vignette Radius";
        }
    } else {
        // Ambilight Modes
        // Show softness slider for all Ambilight modes as they all support corner rounding
        show('ctrl-fade-softness');
        radiusLabel.innerText = (type === 'vignette') ? "Vignette Radius" : "Corner Radius";
    }
    updateFades();
}

function populateFadeEffectOptions(mode) {
    const sel = document.getElementById('fadeEffect');
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '';

    const options = FADE_OPTIONS[mode] || FADE_OPTIONS['solid'];
    options.forEach(opt => {
        const el = document.createElement('option');
        el.value = opt.value;
        el.innerText = opt.text;
        sel.appendChild(el);
    });

    // Try to preserve selection if valid, else default
    if (options.some(o => o.value === currentVal)) sel.value = currentVal;
    else sel.value = options[0].value;
}

function updateFades(skipRender = false) {
    if (!mainBg) return;
    const type = document.getElementById('fadeEffect').value;

    // Remove ALL existing fade effects from canvas to prevent stacking
    canvas.getObjects().filter(o => o.dataTag === 'fade_effect').forEach(o => canvas.remove(o));
    fades = {}; // Reset tracker

    // --- AMBILIGHT MODE LOGIC ---
    if (backgroundMode === 'ambilight') {
        updateAmbilightLayer();

        // Generate Mask for mainBg
        const maskCanvas = generateAlphaMask(type);
        if (maskCanvas) {
            const maskImg = new fabric.Image(maskCanvas);
            // Center the mask relative to mainBg (clipPath is relative to object center)
            maskImg.originX = 'center';
            maskImg.originY = 'center';
            // We don't set left/top because it's relative to the object

            // Apply mask
            mainBg.clipPath = maskImg;
            mainBg.dirty = true; // Force redraw of cached object
        } else {
            mainBg.clipPath = null;
            mainBg.dirty = true;
        }

        if (!skipRender) canvas.requestRenderAll();
        return; // Skip the Solid Color logic below
    }

    // --- SOLID COLOR MODE LOGIC (Existing) ---
    // Ensure Ambilight layer is removed and clipPath cleared
    if (ambilightBg) { canvas.remove(ambilightBg); ambilightBg = null; }
    if (mainBg.clipPath) { mainBg.clipPath = null; mainBg.dirty = true; }

    const addLinear = (side) => {
        const el = document.getElementById('fade' + side.charAt(0).toUpperCase() + side.slice(1));
        if (el && el.value > 0) {
            fades[side] = createFadeRect(side, el.value);
            canvas.add(fades[side]);
            fades[side].moveTo(canvas.getObjects().indexOf(mainBg) + 1);
        }
    };

    if (type === 'custom') {
        ['left', 'right', 'top', 'bottom'].forEach(addLinear);
    } else if (type === 'bottom-left') {
        addCornerFade('bottom-left');
        addLinear('left');
        addLinear('bottom');
    } else if (type === 'bottom-right') {
        addCornerFade('bottom-right');
        addLinear('right');
        addLinear('bottom');
    } else if (type === 'top-left') {
        addCornerFade('top-left');
        addLinear('left');
        addLinear('top');
    } else if (type === 'top-right') {
        addCornerFade('top-right');
        addLinear('right');
        addLinear('top');
    } else if (type === 'vignette') {
        addVignette();
        addLinear('top');
        addLinear('bottom');
    } else if (type === 'soft_round') {
        // Fallback for Solid Mode: just use corner fade logic or custom logic
        // For now, treat as custom but maybe we can improve later.
        // Using 'custom' logic as fallback to allow manual control
        ['left', 'right', 'top', 'bottom'].forEach(addLinear);
    }
    enforceLayering();
    if (!skipRender) canvas.requestRenderAll();
}

// --- NEW HELPER FUNCTIONS FOR AMBILIGHT & MASKS ---

function toggleBackgroundMode(mode) {
    backgroundMode = mode;
    // Update UI visibility if needed (e.g. hide color picker in Ambilight mode)
    const colorPicker = document.getElementById('bgColorContainer'); // Assuming ID
    if (colorPicker) colorPicker.style.display = (mode === 'solid') ? 'block' : 'none';

    populateFadeEffectOptions(mode);
    updateFadeControls();
    updateFades();
    saveToLocalStorage();
}

function updateAmbilightLayer() {
    if (!mainBg) return;

    // 1. Create blurred version if not exists or dirty
    // We use a temporary canvas to generate the blur efficiently
    const srcImg = mainBg.getElement();
    if (!srcImg) return;

    const tempCanvas = document.createElement('canvas');
    // Low res for performance and better blur effect
    const w = canvas.width / 4;
    const h = canvas.height / 4;
    tempCanvas.width = w;
    tempCanvas.height = h;
    const ctx = tempCanvas.getContext('2d');

    // Draw blurred
    // Map bgBrightness (0-100) to brightness filter (0.0 - 2.0)
    // Default 20 -> 0.6 brightness
    const bVal = parseInt(document.getElementById('bgBrightness').value) || 20;
    const brightness = 0.4 + (bVal / 100);
    ctx.filter = `blur(60px) brightness(${brightness})`;
    ctx.drawImage(srcImg, 0, 0, w, h);

    // Create Fabric Image
    if (ambilightBg) canvas.remove(ambilightBg);

    ambilightBg = new fabric.Image(tempCanvas, {
        left: 0, top: 0,
        scaleX: 4, scaleY: 4, // Scale back up
        selectable: false, evented: false,
        dataTag: 'ambilight_bg'
    });

    canvas.add(ambilightBg);
    canvas.sendToBack(ambilightBg);
}

function drawRoundedPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function generateAlphaMask(type) {
    if (!mainBg) return null;

    // Dimensions of the mainBg object (unscaled)
    const w = mainBg.width;
    const h = mainBg.height;

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    const ctx = maskCanvas.getContext('2d');

    // Get Fade Values (scaled to object dimensions)
    // The inputs are in screen pixels, we need to map them to the image's internal coordinate system
    const scaleX = mainBg.scaleX;
    const scaleY = mainBg.scaleY;

    const sT = (parseInt(document.getElementById('fadeTop').value) || 0) / scaleY;
    const sB = (parseInt(document.getElementById('fadeBottom').value) || 0) / scaleY;
    const sL = (parseInt(document.getElementById('fadeLeft').value) || 0) / scaleX;
    const sR = (parseInt(document.getElementById('fadeRight').value) || 0) / scaleX;
    const radius = (parseInt(document.getElementById('fadeRadius').value) || 0) / Math.max(scaleX, scaleY);

    // Softness for soft_round (default to 40 if input missing)
    const softEl = document.getElementById('fadeSoftness');
    const softness = ((softEl ? parseInt(softEl.value) : 40) || 40) / Math.max(scaleX, scaleY);

    // Default: Opaque
    ctx.fillStyle = 'black'; // In clipPath, black/opaque means VISIBLE? No, Fabric uses alpha channel.
    // Wait, Fabric clipPath: "The area of the object that is INSIDE the clipPath is visible."
    // So we need to draw the VISIBLE area.

    // 1. Apply Base Technique
    if (type === 'vignette') {
        // Radial Gradient
        const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        // Stop calculation based on radius slider or fixed
        // Map radius (0-500) to stop (1.0 - 0.0)
        const stop = Math.max(0, 1 - (radius * 2));
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(stop, 'rgba(0,0,0,1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

    } else if (type === 'mask') {
        // Smooth Alpha Mask (Linear Gradients intersection)
        // 1. Clear Canvas
        ctx.clearRect(0, 0, w, h);

        // 2. Vertical Gradient (Source Over)
        // Opaque in center, Transparent at top/bottom edges
        const gV = ctx.createLinearGradient(0, 0, 0, h);
        if (sT > 0) {
            gV.addColorStop(0, 'rgba(0,0,0,0)');
            gV.addColorStop(Math.min(sT / h, 0.5), 'rgba(0,0,0,1)');
        } else {
            gV.addColorStop(0, 'rgba(0,0,0,1)');
        }
        if (sB > 0) {
            gV.addColorStop(Math.max(1 - (sB / h), 0.5), 'rgba(0,0,0,1)');
            gV.addColorStop(1, 'rgba(0,0,0,0)');
        } else {
            gV.addColorStop(1, 'rgba(0,0,0,1)');
        }

        ctx.fillStyle = gV;
        ctx.fillRect(0, 0, w, h);

        // 3. Horizontal Gradient (Destination In - Intersection)
        ctx.globalCompositeOperation = 'destination-in';
        const gH = ctx.createLinearGradient(0, 0, w, 0);
        if (sL > 0) {
            gH.addColorStop(0, 'rgba(0,0,0,0)');
            gH.addColorStop(Math.min(sL / w, 0.5), 'rgba(0,0,0,1)');
        } else {
            gH.addColorStop(0, 'rgba(0,0,0,1)');
        }
        if (sR > 0) {
            gH.addColorStop(Math.max(1 - (sR / w), 0.5), 'rgba(0,0,0,1)');
            gH.addColorStop(1, 'rgba(0,0,0,0)');
        } else {
            gH.addColorStop(1, 'rgba(0,0,0,1)');
        }

        ctx.fillStyle = gH;
        ctx.fillRect(0, 0, w, h);

    } else if (type === 'gradient') {
        // Linear Erasers (Destination Out)
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, w, h);

        ctx.globalCompositeOperation = 'destination-out';
        const addStops = (g) => { g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); };

        if (sT > 0) { const g = ctx.createLinearGradient(0, 0, 0, sT); addStops(g); ctx.fillStyle = g; ctx.fillRect(0, 0, w, sT); }
        if (sB > 0) { const g = ctx.createLinearGradient(0, h, 0, h - sB); addStops(g); ctx.fillStyle = g; ctx.fillRect(0, h - sB, w, sB); }
        if (sL > 0) { const g = ctx.createLinearGradient(0, 0, sL, 0); addStops(g); ctx.fillStyle = g; ctx.fillRect(0, 0, sL, h); }
        if (sR > 0) { const g = ctx.createLinearGradient(w, 0, w - sR, 0); addStops(g); ctx.fillStyle = g; ctx.fillRect(w - sR, 0, sR, h); }

    } else {
        // Default / Soft Round / Custom
        // Start with full visibility
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, w, h);
    }

    // 2. Apply Rounded Corners (Global for Ambilight)
    if (radius > 0) {
        ctx.globalCompositeOperation = 'destination-in';

        if (softness > 0) {
            // Soft Rounding (Feathered)
            const temp = document.createElement('canvas');
            temp.width = w; temp.height = h;
            const tCtx = temp.getContext('2d');

            tCtx.fillStyle = 'black';
            tCtx.filter = `blur(${softness / 2}px)`; // Match fade_demo
            const inset = softness / 2;
            const rectW = Math.max(0, w - inset * 2);
            const rectH = Math.max(0, h - inset * 2);
            const maxR = Math.min(rectW, rectH) / 2;
            const safeR = Math.min(Math.max(0, radius - inset), maxR);
            drawRoundedPath(tCtx, inset, inset, rectW, rectH, safeR);
            tCtx.fill();

            ctx.drawImage(temp, 0, 0);
        } else {
            // Hard Rounding
            const safeR = Math.min(radius, Math.min(w, h) / 2);
            ctx.beginPath();
            drawRoundedPath(ctx, 0, 0, w, h, safeR);
            ctx.fill();
        }
    }

    return maskCanvas;
}

function addCornerFade(pos) {
    const r = parseInt(document.getElementById('fadeRadius').value);
    if (r <= 0) return;
    const bgColor = document.getElementById('bgColor').value;

    const w = mainBg.getScaledWidth();
    const h = mainBg.getScaledHeight();
    let bgLeft = mainBg.left;
    let bgTop = mainBg.top;
    if (mainBg.originX === 'center') bgLeft -= w / 2;
    if (mainBg.originY === 'center') bgTop -= h / 2;

    let rectLeft, rectTop, gradCx, gradCy;

    if (pos === 'bottom-left') {
        rectLeft = bgLeft; rectTop = bgTop + h - r;
        gradCx = 0; gradCy = r;
    } else if (pos === 'bottom-right') {
        rectLeft = bgLeft + w - r; rectTop = bgTop + h - r;
        gradCx = r; gradCy = r;
    } else if (pos === 'top-left') {
        rectLeft = bgLeft; rectTop = bgTop;
        gradCx = 0; gradCy = 0;
    } else if (pos === 'top-right') {
        rectLeft = bgLeft + w - r; rectTop = bgTop;
        gradCx = r; gradCy = 0;
    }

    const grad = new fabric.Gradient({
        type: 'radial',
        coords: { r1: 0, r2: r, x1: gradCx, y1: gradCy, x2: gradCx, y2: gradCy },
        colorStops: [{ offset: 0, color: bgColor }, { offset: 1, color: hexToRgba(bgColor, 0) }]
    });

    fades.corner = new fabric.Rect({ left: rectLeft, top: rectTop, width: r, height: r, fill: grad, selectable: false, evented: false, dataTag: 'fade_effect' });
    canvas.add(fades.corner);
    fades.corner.moveTo(canvas.getObjects().indexOf(mainBg) + 1);
}

function addVignette() {
    const r = parseInt(document.getElementById('fadeRadius').value);
    if (r <= 0) return;
    const bgColor = document.getElementById('bgColor').value;
    const padding = 10;
    const w = Math.ceil(mainBg.getScaledWidth()) + padding;
    const h = Math.ceil(mainBg.getScaledHeight()) + padding;

    let bgLeft = mainBg.left;
    let bgTop = mainBg.top;
    if (mainBg.originX === 'center') bgLeft -= mainBg.getScaledWidth() / 2;
    if (mainBg.originY === 'center') bgTop -= mainBg.getScaledHeight() / 2;

    const grad = new fabric.Gradient({
        type: 'radial',
        coords: { r1: 0, r2: r, x1: w / 2, y1: h / 2, x2: w / 2, y2: h / 2 },
        colorStops: [{ offset: 0, color: hexToRgba(bgColor, 0) }, { offset: 1, color: bgColor }]
    });

    fades.corner = new fabric.Rect({ left: bgLeft - (padding / 2), top: bgTop - (padding / 2), width: w, height: h, fill: grad, selectable: false, evented: false, dataTag: 'fade_effect' });
    canvas.add(fades.corner);
    fades.corner.moveTo(canvas.getObjects().indexOf(mainBg) + 1);
}

function createFadeRect(type, size) {
    const bgColor = document.getElementById('bgColor').value;
    const b = 2;
    const wImg = mainBg.getScaledWidth();
    const hImg = mainBg.getScaledHeight();

    let bgLeft = mainBg.left;
    let bgTop = mainBg.top;
    if (mainBg.originX === 'center') bgLeft -= wImg / 2;
    if (mainBg.originY === 'center') bgTop -= hImg / 2;

    let w, h, x, y, c;
    if (type === 'left') { w = parseInt(size) + b; h = hImg + b * 2; x = bgLeft - b; y = bgTop - b; c = { x1: 0, y1: 0, x2: 1, y2: 0 }; }
    else if (type === 'right') { w = parseInt(size) + b; h = hImg + b * 2; x = bgLeft + wImg - size; y = bgTop - b; c = { x1: 1, y1: 0, x2: 0, y2: 0 }; }
    else if (type === 'top') { w = wImg + b * 2; h = parseInt(size) + b; x = bgLeft - b; y = bgTop - b; c = { x1: 0, y1: 0, x2: 0, y2: 1 }; }
    else if (type === 'bottom') { w = wImg + b * 2; h = parseInt(size) + b; x = bgLeft - b; y = bgTop + hImg - size; c = { x1: 0, y1: 1, x2: 0, y2: 0 }; }
    return new fabric.Rect({
        left: x, top: y, width: w, height: h, selectable: false, evented: false,
        fill: new fabric.Gradient({ type: 'linear', gradientUnits: 'percentage', coords: c, colorStops: [{ offset: 0, color: bgColor }, { offset: 1, color: hexToRgba(bgColor, 0) }] }),
        dataTag: 'fade_effect'
    });
}

function hexToRgba(hex, a) {
    let r = 0, g = 0, b = 0;
    if (hex.length === 4) {
        r = parseInt(hex[1] + hex[1], 16);
        g = parseInt(hex[2] + hex[2], 16);
        b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length === 7) {
        r = parseInt(hex.slice(1, 3), 16);
        g = parseInt(hex.slice(3, 5), 16);
        b = parseInt(hex.slice(5, 7), 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${a === 0 ? 0.005 : a})`;
}

async function loadOverlayProfiles() {
    try {
        const resp = await fetch('/api/overlays/list');
        overlayProfiles = await resp.json();

        // Merge local margins (since backend might not store them yet)
        const localMargins = JSON.parse(localStorage.getItem('overlay_margins_map') || '{}');
        overlayProfiles.forEach(p => {
            if (localMargins[p.id]) {
                // Migration: If legacy format (array of presets), take the first one's areas
                if (Array.isArray(localMargins[p.id]) && localMargins[p.id].length > 0 && localMargins[p.id][0].areas) {
                    p.blocked_areas = localMargins[p.id][0].areas;
                } else {
                    // Assume it's the new format (direct array of areas) or empty
                    p.blocked_areas = Array.isArray(localMargins[p.id]) ? localMargins[p.id] : [];
                }
            }
        });

        // Populate Dropdown
        const sel = document.getElementById('overlaySelect');
        if (sel) {
            const current = sel.value;
            sel.innerHTML = '<option value="">None</option>';
            overlayProfiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = p.name;
                sel.appendChild(opt);
            });

            if (window.restoredOverlayId) {
                sel.value = window.restoredOverlayId;
                updateOverlay();
                window.restoredOverlayId = null;
            } else {
                sel.value = current;
            }
        }

        // Populate Manager List
        const list = document.getElementById('overlayList');
        if (list) {
            let html = '<table style="width:100%; text-align:left; border-collapse: collapse;"><tr><th style="border-bottom:1px solid #555; padding:5px;">Name</th><th style="border-bottom:1px solid #555; padding:5px;">1080p</th><th style="border-bottom:1px solid #555; padding:5px;">4K</th><th style="border-bottom:1px solid #555; padding:5px;">Action</th></tr>';
            overlayProfiles.forEach(p => {
                html += `<tr>
                    <td style="padding:5px;">${p.name}</td>
                    <td style="padding:5px;">${p.file_1080 ? '✅' : '❌'}</td>
                    <td style="padding:5px;">${p.file_4k ? '✅' : '❌'}</td>
                    <td style="padding:5px;">
                        <button onclick="openOverlayMarginEditor('${p.id}')" style="background:#1976d2; padding:4px 8px; font-size:12px; border:none; color:white; cursor:pointer; margin-right:5px;">Edit Margins</button>
                        <button onclick="deleteOverlay('${p.id}')" style="background:#c62828; padding:4px 8px; font-size:12px; border:none; color:white; cursor:pointer;">Delete</button>
                    </td>
                </tr>`;
            });
            html += '</table>';
            list.innerHTML = html;
        }
    } catch (e) { console.error("Error loading overlays", e); }
}

async function addOverlay() {
    const name = document.getElementById('newOverlayName').value;
    const f1080 = document.getElementById('newOverlay1080').files[0];
    const f4k = document.getElementById('newOverlay4K').files[0];

    if (!name) return alert("Name is required");

    const formData = new FormData();
    formData.append('name', name);
    if (f1080) formData.append('file_1080', f1080);
    if (f4k) formData.append('file_4k', f4k);

    const btn = document.querySelector('button[onclick="addOverlay()"]');
    const originalText = btn.innerText;
    btn.innerText = "Uploading...";
    btn.disabled = true;

    const resp = await fetch('/api/overlays/add', { method: 'POST', body: formData });
    if (resp.ok) {
        alert("Overlay profile saved!");
        document.getElementById('newOverlayName').value = '';
        document.getElementById('newOverlay1080').value = '';
        document.getElementById('newOverlay4K').value = '';
        loadOverlayProfiles();
    } else {
        alert("Error saving overlay");
    }
    btn.innerText = originalText;
    btn.disabled = false;
}

async function deleteOverlay(id) {
    if (!confirm("Delete this overlay profile?")) return;
    await fetch(`/api/overlays/delete/${id}`, { method: 'POST' });
    loadOverlayProfiles();
    const sel = document.getElementById('overlaySelect');
    if (sel && sel.value === id) {
        sel.value = "";
        updateOverlay();
    }
}

function initOverlayCanvas() {
    if (overlayCanvasFabric) return;
    // Initialize with 1920x1080 logic
    overlayCanvasFabric = new fabric.Canvas('overlayCanvas', { width: 1920, height: 1080, backgroundColor: '#000000' });

    // CSS scaling for the container
    const canvasEl = document.getElementById('overlayCanvas');
    canvasEl.style.width = '100%';
    canvasEl.style.height = '100%';
}

function openOverlayMarginEditor(id) {
    const profile = overlayProfiles.find(p => p.id === id);
    if (!profile) return;

    currentEditingOverlayId = id;
    document.getElementById('overlayMarginEditor').style.display = 'block';
    initOverlayCanvas();
    overlayCanvasFabric.clear();
    overlayCanvasFabric.setBackgroundColor('#000000', overlayCanvasFabric.renderAll.bind(overlayCanvasFabric));

    // Load Overlay Image
    const file = profile.file_1080 || profile.file_4k;
    if (file) {
        const url = `/api/overlays/image/${file}`;
        fabric.Image.fromURL(url, img => {
            img.set({
                left: 0, top: 0,
                selectable: false, evented: false,
                opacity: 0.5,
                scaleX: 1920 / img.width,
                scaleY: 1080 / img.height
            });
            overlayCanvasFabric.add(img);
            overlayCanvasFabric.sendToBack(img);
        });
    }

    loadBlockedAreasToCanvas(profile.blocked_areas || []);
}

function loadBlockedAreasToCanvas(areas) {
    // Clear existing boxes
    const existing = overlayCanvasFabric.getObjects().filter(o => o.dataTag === 'blocked_area');
    existing.forEach(o => overlayCanvasFabric.remove(o));

    areas.forEach(area => {
        const rectObj = new fabric.Rect({
            left: area.left,
            top: area.top,
            width: area.width,
            height: area.height,
            fill: 'rgba(255, 0, 0, 0.3)',
            stroke: 'red',
            strokeWidth: 2,
            cornerColor: 'white',
            cornerSize: 20,
            transparentCorners: false,
            dataTag: 'blocked_area'
        });
        overlayCanvasFabric.add(rectObj);
    });
    overlayCanvasFabric.requestRenderAll();
}

function addBlockedRect() {
    const rectObj = new fabric.Rect({
        left: 100, top: 100, width: 200, height: 100,
        fill: 'rgba(255, 0, 0, 0.3)', stroke: 'red', strokeWidth: 2,
        cornerColor: 'white', cornerSize: 20, transparentCorners: false,
        dataTag: 'blocked_area'
    });
    overlayCanvasFabric.add(rectObj);
    overlayCanvasFabric.setActiveObject(rectObj);
}

function closeOverlayMarginEditor() {
    document.getElementById('overlayMarginEditor').style.display = 'none';
    currentEditingOverlayId = null;
}

async function saveOverlayMargins() {
    if (!currentEditingOverlayId || !overlayCanvasFabric) return;

    const rects = overlayCanvasFabric.getObjects().filter(o => o.dataTag === 'blocked_area');
    const areas = rects.map(r => ({
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.getScaledWidth()),
        height: Math.round(r.getScaledHeight())
    }));

    // Save to LocalStorage (simulating backend persistence)
    const map = JSON.parse(localStorage.getItem('overlay_margins_map') || '{}');
    map[currentEditingOverlayId] = areas;
    localStorage.setItem('overlay_margins_map', JSON.stringify(map));

    // Update in-memory profile
    const profile = overlayProfiles.find(p => p.id === currentEditingOverlayId);
    if (profile) profile.blocked_areas = areas;

    // --- NEW: Save to Server (overlays.json) so Cron Job sees it globally ---
    try {
        await fetch('/api/overlays/update_margins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentEditingOverlayId, blocked_areas: areas })
        });
    } catch (e) { console.error("Failed to save margins to server", e); }
    // -----------------------------------------------------------------------

    alert("Blocked areas saved!");
    closeOverlayMarginEditor();
}

function enforceLayering() {
    if (!canvas) return;
    const grids = canvas.getObjects().filter(o => o.dataTag === 'grid_line');
    const overlays = canvas.getObjects().filter(o => o.dataTag === 'guide_overlay');
    const fades = canvas.getObjects().filter(o => o.dataTag === 'fade_effect');
    const ambilight = canvas.getObjects().filter(o => o.dataTag === 'ambilight_bg');

    grids.forEach(o => canvas.sendToBack(o));
    fades.forEach(o => canvas.sendToBack(o));
    if (mainBg) canvas.sendToBack(mainBg);
    ambilight.forEach(o => canvas.sendToBack(o));
    overlays.forEach(o => canvas.bringToFront(o));
}

function updateOverlay() {
    const sel = document.getElementById('overlaySelect');
    const overlayId = sel ? sel.value : "";

    const existing = canvas.getObjects().find(o => o.dataTag === 'guide_overlay');
    if (existing) canvas.remove(existing);

    activeBlockedAreas = [];

    if (!overlayId) {
        // Reset margins to default
        document.getElementById('marginTopInput').value = 20;
        document.getElementById('marginBottomInput').value = 20;
        document.getElementById('marginLeftInput').value = 20;
        document.getElementById('marginRightInput').value = 20;
        updateVerticalLayout(); // Reset layout when overlay is removed
        canvas.requestRenderAll();
        return;
    }

    const profile = overlayProfiles.find(p => p.id === overlayId);
    if (!profile) return;

    activeBlockedAreas = profile.blocked_areas || [];
    updateVerticalLayout();

    const is4K = canvas.width > 2000;
    let file = is4K ? profile.file_4k : profile.file_1080;
    if (!file) file = is4K ? profile.file_1080 : profile.file_4k; // Fallback

    if (file) {
        const url = `/api/overlays/image/${file}`;
        fabric.Image.fromURL(url, img => {
            if (!img) return;
            img.set({
                left: 0, top: 0,
                selectable: false, evented: false,
                opacity: 0.5,
                dataTag: 'guide_overlay',
                scaleX: canvas.width / img.width,
                scaleY: canvas.height / img.height
            });
            canvas.add(img);
            canvas.bringToFront(img);
            enforceLayering();
            canvas.requestRenderAll();
        });
    }
}

async function loadTextureProfiles() {
    try {
        const resp = await fetch('/api/textures/list');
        textureProfiles = await resp.json();

        const sel = document.getElementById('textureSelect');
        if (sel) {
            const current = sel.value;
            sel.innerHTML = '<option value="">Select Texture...</option>';
            textureProfiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = p.name;
                sel.appendChild(opt);
            });
            sel.value = current;
        }

        const list = document.getElementById('textureList');
        if (list) {
            let html = '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(100px, 1fr)); gap:10px;">';
            textureProfiles.forEach(p => {
                const src = `/api/textures/image/${p.filename}`;
                html += `<div style="background:rgba(255,255,255,0.1); padding:5px; border-radius:4px; text-align:center;">
                    <img src="${src}" style="width:100%; height:60px; object-fit:cover; border-radius:4px;">
                    <div style="font-size:11px; margin:5px 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.name}</div>
                    <button onclick="deleteTexture('${p.id}')" style="background:#c62828; padding:2px 6px; font-size:10px; width:100%; border:none; color:white; cursor:pointer;">Delete</button>
                </div>`;
            });
            html += '</div>';
            list.innerHTML = html;
        }
    } catch (e) { console.error("Error loading textures", e); }
}

async function loadFonts() {
    try {
        const resp = await fetch('/api/fonts/list');
        const families = await resp.json(); // These are now just ["Inter", "Roboto", ...]

        const sel = document.getElementById('fontFamilySelect');

        // Add custom group to dropdown if not exists
        let customGroup = document.getElementById('customFontsGroup');
        if (!customGroup && sel) {
            customGroup = document.createElement('optgroup');
            customGroup.id = 'customFontsGroup';
            customGroup.label = 'Custom Fonts';
            sel.prepend(customGroup);
        }
        if (customGroup) customGroup.innerHTML = '';

        // NOTE: For the Manager Tab (delete), it would be better to list files.
        // But for the dropdown we need families.
        // Workaround: We use families only for the dropdown.

        if (customGroup) {
            families.forEach(family => {
                const opt = document.createElement('option');
                opt.value = family;
                opt.innerText = family;
                // We set the font-family style directly on the option so you can see a preview
                opt.style.fontFamily = family;
                customGroup.appendChild(opt);
            });
        }

    } catch (e) { console.error("Error loading fonts", e); }
}

async function addFont() {
    const fileInput = document.getElementById('newFontFile');
    const file = fileInput.files[0];
    if (!file) return alert("Please select a font file");

    const formData = new FormData();
    formData.append('file', file);

    const btn = document.querySelector('button[onclick="addFont()"]');
    const originalText = btn.innerText;
    btn.innerText = "Uploading...";
    btn.disabled = true;

    const resp = await fetch('/api/fonts/add', { method: 'POST', body: formData });
    if (resp.ok) {
        alert("Font uploaded!");
        fileInput.value = '';
        loadFonts();
    } else {
        const err = await resp.json();
        alert("Error: " + (err.message || "Upload failed"));
    }
    btn.innerText = originalText;
    btn.disabled = false;
}

async function deleteFont(filename) {
    if (!confirm(`Delete font "${filename}"?`)) return;
    await fetch(`/api/fonts/delete/${encodeURIComponent(filename)}`, { method: 'POST' });
    loadFonts();
}

async function loadCustomIcons() {
    try {
        const resp = await fetch('/api/custom-icons/list');
        const icons = await resp.json();

        // Populate Manager List
        const list = document.getElementById('customIconList');
        if (list) {
            let html = '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(100px, 1fr)); gap:10px;">';
            icons.forEach(icon => {
                const src = `/api/custom-icons/image/${encodeURIComponent(icon)}`;
                html += `<div style="background:rgba(255,255,255,0.1); padding:5px; border-radius:4px; text-align:center;">
                    <img src="${src}" style="width:100%; height:60px; object-fit:contain; border-radius:4px;">
                    <div style="font-size:11px; margin:5px 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${icon}</div>
                    <button onclick="deleteCustomIcon('${icon}')" style="background:#c62828; padding:2px 6px; font-size:10px; width:100%; border:none; color:white; cursor:pointer;">Delete</button>
                </div>`;
            });
            html += '</div>';
            list.innerHTML = html;
        }

        // Populate Sidebar
        const sidebar = document.getElementById('customLogosSidebar');
        if (sidebar) {
            let html = '';
            html += `<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/IMDB_Logo_2016.svg/1200px-IMDB_Logo_2016.svg.png" onclick="addLogo('https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/IMDB_Logo_2016.svg/1200px-IMDB_Logo_2016.svg.png')" style="width:100%; height:40px; object-fit:contain; cursor:pointer; background:rgba(255,255,255,0.1); border-radius:4px; padding:2px;" title="IMDb Logo">`;
            icons.forEach(icon => {
                const src = `/api/custom-icons/image/${encodeURIComponent(icon)}`;
                html += `<img src="${src}" onclick="addLogo('${src}')" style="width:100%; height:40px; object-fit:contain; cursor:pointer; background:rgba(255,255,255,0.1); border-radius:4px; padding:2px;" title="${icon}">`;
            });
            sidebar.innerHTML = html;
        }
    } catch (e) { console.error("Error loading custom icons", e); }
}

async function addCustomIcon() {
    const fileInput = document.getElementById('newIconFile');
    const file = fileInput.files[0];
    if (!file) return alert("Please select a file");

    const formData = new FormData();
    formData.append('file', file);

    const resp = await fetch('/api/custom-icons/add', { method: 'POST', body: formData });
    if (resp.ok) {
        alert("Icon uploaded!");
        fileInput.value = '';
        loadCustomIcons();
    } else {
        alert("Error uploading icon");
    }
}

async function deleteCustomIcon(filename) {
    if (!confirm(`Delete icon "${filename}"?`)) return;
    await fetch(`/api/custom-icons/delete/${encodeURIComponent(filename)}`, { method: 'POST' });
    loadCustomIcons();
}

async function addTexture() {
    const name = document.getElementById('newTextureName').value;
    const file = document.getElementById('newTextureFile').files[0];
    if (!name || !file) return alert("Name and file required");

    const formData = new FormData();
    formData.append('name', name);
    formData.append('file', file);

    const btn = document.querySelector('button[onclick="addTexture()"]');
    const originalText = btn.innerText;
    btn.innerText = "Uploading...";
    btn.disabled = true;

    const resp = await fetch('/api/textures/add', { method: 'POST', body: formData });
    if (resp.ok) {
        alert("Texture saved!");
        document.getElementById('newTextureName').value = '';
        document.getElementById('newTextureFile').value = '';
        loadTextureProfiles();
    } else {
        alert("Error saving texture");
    }
    btn.innerText = originalText;
    btn.disabled = false;
}

async function deleteTexture(id) {
    if (!confirm("Delete this texture?")) return;
    await fetch(`/api/textures/delete/${id}`, { method: 'POST' });
    loadTextureProfiles();
}

function updateTextureScale() {
    const val = document.getElementById('textureScale').value;
    document.getElementById('textureScaleVal').innerText = val + "x";
    applyTextureToSelection();
}

function updateTextureRotation() {
    const val = document.getElementById('textureRotation').value;
    document.getElementById('textureRotationVal').innerText = val + "°";
    applyTextureToSelection();
}

function updateTextureOpacity() {
    const val = document.getElementById('textureOpacity').value;
    document.getElementById('textureOpacityVal').innerText = val + "%";
    applyTextureToSelection();
}

function resetTextureSettings() {
    document.getElementById('textureScale').value = 1;
    document.getElementById('textureScaleVal').innerText = "1x";
    document.getElementById('textureRotation').value = 0;
    document.getElementById('textureRotationVal').innerText = "0°";
    document.getElementById('textureOpacity').value = 100;
    document.getElementById('textureOpacityVal').innerText = "100%";
    applyTextureToSelection();
}

function toggleTextFillType() {
    const type = document.querySelector('input[name="fillType"]:checked').value;
    document.getElementById('fillColorContainer').style.display = (type === 'color') ? 'block' : 'none';
    document.getElementById('fillTextureContainer').style.display = (type === 'texture') ? 'block' : 'none';

    if (type === 'color') {
        updateSelectedColor();
    } else {
        applyTextureToSelection();
    }
}

function applyTextureToSelection() {
    const activeObj = canvas.getActiveObject();
    if (!activeObj) return;

    const textureId = document.getElementById('textureSelect').value;
    if (!textureId) return;

    const scale = parseFloat(document.getElementById('textureScale').value) || 1;
    const rotation = parseInt(document.getElementById('textureRotation').value) || 0;
    const opacity = parseInt(document.getElementById('textureOpacity').value) / 100;

    const profile = textureProfiles.find(p => p.id === textureId);
    if (!profile) return;

    const url = `/api/textures/image/${profile.filename}`;

    const rad = rotation * Math.PI / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const matrix = [scale * c, scale * s, -scale * s, scale * c, 0, 0];

    fabric.util.loadImage(url, function (img) {
        if (!img) return;

        let source = img;
        if (opacity < 1) {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.globalAlpha = opacity;
            ctx.drawImage(img, 0, 0);
            source = c;
        }

        const pattern = new fabric.Pattern({
            source: source,
            repeat: 'repeat',
            patternTransform: matrix
        });

        const applyToObj = (obj) => {
            if (obj.type === 'i-text' || obj.type === 'textbox') {
                obj.set('fill', pattern);
                obj.set('textureId', textureId);
                obj.set('textureScale', scale);
                obj.set('textureRotation', rotation);
                obj.set('textureOpacity', opacity);
            } else if (obj.type === 'group') {
                const t = obj.getObjects().find(o => o.type === 'i-text');
                if (t) {
                    t.set('fill', pattern);
                    t.set('textureId', textureId);
                    t.set('textureScale', scale);
                    t.set('textureRotation', rotation);
                    t.set('textureOpacity', opacity);
                }
            }
        };

        applyToObj(activeObj);
        canvas.requestRenderAll();
        saveToLocalStorage();
    });
}

function updateBgColor(skipRender = false) {
    if (!canvas) return Promise.resolve();

    const bgColorHex = document.getElementById('bgColor').value;
    canvas.getObjects().forEach(obj => {
        if ((obj.type === 'textbox' || obj.type === 'i-text' || obj.type === 'image') && obj.autoBackgroundColor && obj.backgroundColor) {
            const c = new fabric.Color(obj.backgroundColor);
            const currentOpacity = c.getSource()[3];
            const rgb = new fabric.Color(bgColorHex).getSource();
            obj.set('backgroundColor', `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${currentOpacity})`);
        }
    });

    return new Promise(resolve => {
        canvas.setBackgroundColor(bgColorHex, () => {
            updateFades(true);
            if (!skipRender) canvas.requestRenderAll();
            resolve();
        });
    });
}

function setUIInteraction(enabled) {
    const elements = document.querySelectorAll('button, input, select, textarea, .tab-link');
    elements.forEach(el => {
        if (el.classList.contains('tab-link')) {
            el.style.pointerEvents = enabled ? 'auto' : 'none';
            el.style.opacity = enabled ? '1' : '0.5';
        } else {
            el.disabled = !enabled;
        }
    });

    // Disable canvas interaction
    const canvasWrapper = document.getElementById('canvas-wrapper');
    if (canvasWrapper) {
        canvasWrapper.style.pointerEvents = enabled ? 'auto' : 'none';
        canvasWrapper.style.opacity = enabled ? '1' : '0.8';
    }

    if (enabled) updateSelectionUI();
}


function changeResolution() {
    if (gridEnabled) removeGrid();
    const res = document.getElementById('resSelect').value;
    localStorage.setItem('editor_resolution', res);
    const targetW = (res === '2160') ? 3840 : 1920;
    const scale = targetW / canvas.width;
    canvas.setDimensions({ width: targetW, height: (res === '2160' ? 2160 : 1080) });
    canvas.getObjects().forEach(obj => { obj.scaleX *= scale; obj.scaleY *= scale; obj.left *= scale; obj.top *= scale; obj.setCoords(); });
    if (gridEnabled) drawGrid();
    updateFades();
    updateOverlay();
}

async function saveLayout() {
    const name = document.getElementById('layoutName').value;
    if (!name) return alert("Please enter a layout name");

    const btn = document.querySelector('button[onclick="saveLayout()"]');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Saving Layout...";
    setUIInteraction(false);

    const layout = canvas.toJSON(['dataTag', 'fullMediaText', 'selectable', 'evented', 'lockScalingY', 'splitByGrapheme', 'fixedHeight', 'editable', 'matchHeight', 'autoBackgroundColor', 'textureId', 'textureScale', 'textureRotation', 'textureOpacity', 'snapToObjects', 'logoAutoFix', 'maxItems', 'fullList', 'slotWidth', 'slotHeight']);

    // Filter out fade effects and grid lines BEFORE saving
    layout.objects = layout.objects.filter(o => o.dataTag !== 'fade_effect' && o.dataTag !== 'grid_line' && o.dataTag !== 'guide_overlay' && o.dataTag !== 'ambilight_bg' && o.dataTag !== 'separator' && o.dataTag !== 'row_separator');

    // Normalize to 1080p base resolution
    const currentScale = canvas.width / BASE_WIDTH;
    if (currentScale !== 1) {
        layout.objects.forEach(obj => {
            obj.left /= currentScale;
            obj.top /= currentScale;
            obj.scaleX /= currentScale;
            obj.scaleY /= currentScale;
        });
    }

    // Convert absolute URLs to relative
    layout.objects.forEach(obj => {
        if (obj.type === 'image' && obj.src && obj.src.startsWith(window.location.origin)) {
            obj.src = obj.src.replace(window.location.origin, '');
        }
    });

    layout.custom_effects = {
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

    // Save blocked areas to JSON so render_task.js can use them
    const overlayId = document.getElementById('overlaySelect').value;
    if (overlayId) {
        const profile = overlayProfiles.find(p => p.id === overlayId);
        if (profile && profile.blocked_areas) {
            layout.custom_effects.blocked_areas = profile.blocked_areas;
        }
    }

    // Generate Preview Thumbnail (smaller size)
    const previewData = canvas.toDataURL({ format: 'jpeg', quality: 0.8, multiplier: 0.5 });

    // Use shared metadata builder
    const fullMetadata = extractMetadata(lastFetchedData);
    const actionUrl = fullMetadata.action_url;
    const mediaTitle = fullMetadata.title;

    const resp = await fetch('/api/layouts/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            name,
            layout,
            preview_image: previewData,
            action_url: actionUrl,
            media_title: mediaTitle,
            metadata: fullMetadata
        })
    });
    if (!resp.ok) {
        alert("Error saving layout");
        btn.innerText = originalText;
        btn.disabled = false;
        setUIInteraction(true);
        return;
    }

    // Generate 10 Previews
    const generatedImages = [];
    isBatchRunning = true; // Suppress UI updates in fetchRandomPreview
    try {
        for (let i = 0; i < 10; i++) {
            btn.innerText = `Generating ${i + 1}/10...`;
            await fetchRandomPreview();
            const res = await saveToGalleryInternal(name, null, 'layout_preview');
            if (res && res.status === 'success') generatedImages.push(res.filename);
        }
    } catch (e) { console.error(e); }
    finally {
        isBatchRunning = false;
        btn.innerText = originalText;
        btn.disabled = false;
        setUIInteraction(true);
    }

    loadLayoutsList();
    await loadGallery(); // Refresh gallery data so lightbox works
    showPreviewPopup(name, generatedImages);
}

function showPreviewPopup(layoutName, images) {
    const grid = document.getElementById('preview-grid');
    grid.innerHTML = '';
    const layoutKey = `LayoutPreview: ${layoutName}`;

    images.forEach(img => {
        const src = `/api/gallery/image/${encodeURIComponent(layoutKey)}/${encodeURIComponent(img)}`;
        grid.innerHTML += `
            <div class="gallery-item">
                <img src="${src}" onclick="closePreviewPopup(); openLightbox('${layoutKey}', ${loadedGalleryData[layoutKey].indexOf(img)})">
                <div class="caption">${img}</div>
                <button onclick="closePreviewPopup(); editGalleryImage('${layoutKey}', '${img}')" style="position:absolute; top:5px; right:5px; width:auto; padding:4px 8px; font-size:12px; background:rgba(0,0,0,0.7); border:1px solid #fff; cursor:pointer; color:white;">✏️</button>
            </div>`;
    });
    document.getElementById('preview-popup').style.display = 'flex';
}

function closePreviewPopup() {
    document.getElementById('preview-popup').style.display = 'none';
}

async function loadLayout(name, silent = false) {
    if (!silent) console.log(`Loading layout: ${name}`);
    const resp = await fetch(`/api/layouts/load/${name}`);
    if (!resp.ok) {
        console.error(`Failed to fetch layout: ${name}`);

        if (!silent) alert("Error loading layout");
        return;
    }
    const data = await resp.json();
    if (!silent) console.log("Layout JSON fetched, starting canvas.loadFromJSON...");

    // Scale up to current resolution
    const currentRes = document.getElementById('resSelect').value;
    const targetW = (currentRes === '2160') ? 3840 : 1920;
    const scaleFactor = targetW / BASE_WIDTH;

    if (scaleFactor !== 1) {
        data.objects.forEach(obj => {
            obj.left *= scaleFactor;
            obj.top *= scaleFactor;
            obj.scaleX *= scaleFactor;
            obj.scaleY *= scaleFactor;
            if (obj.slotWidth) obj.slotWidth *= scaleFactor;
            if (obj.slotHeight) obj.slotHeight *= scaleFactor;
        });
    }

    return new Promise((resolve) => {
        if (data.metadata) lastFetchedData = data.metadata;

        // Hier nutzen wir den Callback (1. Funktion) UND den Reviver (2. Funktion für Gradienten)
        canvas.loadFromJSON(data, () => {
            if (!silent) console.log("loadFromJSON callback fired.");

            // --- CALLBACK START (Wird ausgeführt, wenn alles geladen ist) ---
            canvas.getObjects().forEach(o => { if (o.dataTag === 'overview') o.set('objectCaching', false); });

            mainBg = canvas.getObjects().find(o => o.dataTag === 'background');
            const title = canvas.getObjects().find(o => o.dataTag === 'title' && o.type === 'image');
            if (title) {
                if (!title.slotWidth) title.slotWidth = title.getScaledWidth();
                if (!title.slotHeight) title.slotHeight = title.getScaledHeight();
                preferredLogoWidth = title.slotWidth;
            }

            // Fallback Background
            if (!mainBg && canvas.getObjects().length > 0) {
                const firstObj = canvas.item(0);
                if (firstObj && firstObj.type === 'image' && firstObj.width > 500) {
                    mainBg = firstObj;
                    mainBg.set('dataTag', 'background');
                }
            }
            if (mainBg) mainBg.set({ selectable: true, evented: true });

            // Remove ghosts
            const ghosts = canvas.getObjects().filter(o => o.dataTag === 'fade_effect' || o.dataTag === 'grid_line');
            ghosts.forEach(g => canvas.remove(g));

            document.getElementById('layoutName').value = name;

            // UI Updates
            if (data.custom_effects) {
                applyCustomEffects(data.custom_effects);
                updateFadeControls();
                updateBgColor();
            } else {
                updateFades();
            }

            const btnSaveGallery = document.getElementById('btn-save-gallery');
            if (btnSaveGallery) btnSaveGallery.disabled = true;

            const btnShuffle = document.getElementById('btn-shuffle');
            if (btnShuffle) btnShuffle.disabled = false;

            if (!silent) {
                openTab({ currentTarget: document.querySelector('.tab-link') }, 'editor-tab');
                // alert(`Layout "${name}" loaded!`); // Alert nervt oft, kann ausbleiben
            }

            // --- HIER IST DER FIX: Warten auf Schriften statt setTimeout ---
            if (!silent) console.log("Waiting for fonts...");
            waitForUsedFonts(canvas).then(() => {
                if (!silent) console.log("Fonts loaded.");
                canvas.getObjects().forEach(o => o.setCoords()); // Koordinaten neu berechnen
                updateVerticalLayout(); // Jetzt Text ausrichten (da Breiten nun stimmen)
                if (!silent) console.log("Layout update complete.");
                canvas.requestRenderAll();
                resolve();
            }).catch(err => {
                console.error("Error in waitForUsedFonts:", err);
                resolve(); // Still resolve to let it proceed
            });
            // --- FIX ENDE ---


        }, (o, object) => {
            // --- REVIVER START (Deine Gradienten-Reparatur) ---
            if (object.fill && object.fill.type === 'linear' && object.fill.colorStops && object.fill.colorStops.length > 0) {
                try {
                    if (object.dataTag === 'fade_effect') {
                        let loadedColor = "#000000";
                        let rawColor = object.fill.colorStops[0].color;

                        if (rawColor && rawColor.startsWith('rgb')) {
                            const rgb = rawColor.match(/\d+/g);
                            if (rgb && rgb.length >= 3) {
                                loadedColor = "#" +
                                    ("0" + parseInt(rgb[0], 10).toString(16)).slice(-2) +
                                    ("0" + parseInt(rgb[1], 10).toString(16)).slice(-2) +
                                    ("0" + parseInt(rgb[2], 10).toString(16)).slice(-2);
                            }
                        } else if (rawColor && rawColor.startsWith('#')) {
                            loadedColor = rawColor;
                        }

                        const picker = document.getElementById('bgColor');
                        if (picker && loadedColor && picker.value.toLowerCase() !== loadedColor.toLowerCase()) {
                            picker.value = loadedColor;
                        }
                    }
                    const freshStops = object.fill.colorStops.map(stop => ({
                        offset: stop.offset,
                        color: stop.color
                    }));
                    object.fill.colorStops = freshStops;
                    object.dirty = true;
                } catch (e) {
                    console.warn("Failed to restore gradient for object:", object, e);
                }
            }
            // --- REVIVER ENDE ---
        });
    });
}

function resetLayout() {
    if (!confirm("Are you sure you want to reset the layout? All unsaved changes will be lost.")) return;

    // 1. Clear Storage
    localStorage.removeItem('autosave_layout');
    localStorage.removeItem('editor_resolution');

    // 2. Reset Globals
    mainBg = null;
    fades = {};
    preferredLogoWidth = null;
    lastFetchedData = null;
    lastValidBgState = null;

    // 3. Reset UI Controls
    const resSelect = document.getElementById('resSelect');
    if (resSelect) resSelect.value = '1080';

    if (document.getElementById('bgColor')) document.getElementById('bgColor').value = '#000000';
    if (document.getElementById('bgBrightness')) {
        document.getElementById('bgBrightness').value = 20;
        document.getElementById('brightVal').innerText = '20%';
    }
    if (document.getElementById('fadeEffect')) document.getElementById('fadeEffect').value = 'none';
    if (document.getElementById('layoutName')) document.getElementById('layoutName').value = 'Default';
    if (document.getElementById('overlaySelect')) document.getElementById('overlaySelect').value = '';

    // 4. Reset Canvas (Default 1080p)
    // Reset Editing UI if active
    document.getElementById('btn-save-changes').style.display = 'none';
    document.getElementById('btn-save-layout').style.display = 'block';
    document.getElementById('layoutNameContainer').style.display = 'block';
    undoStack = [];
    redoStack = [];
    updateUndoRedoUI();

    canvas.clear();
    canvas.setDimensions({ width: 1920, height: 1080 });
    canvas.setBackgroundColor('#000000', canvas.renderAll.bind(canvas));

    // 5. Force UI Updates
    updateFadeControls();
    updateOverlay();

    // 6. Load default background
    if (window.initialBackdropUrl) loadBackground(window.initialBackdropUrl);
}

function mirrorBackground() {
    if (!mainBg) return;
    mainBg.set('flipX', !mainBg.flipX);
    canvas.requestRenderAll();
}

function saveToLocalStorage() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(performSaveToLocalStorage, 1000);
}

function performSaveToLocalStorage() {
    if (!canvas) return;
    const json = canvas.toJSON(['dataTag', 'fullMediaText', 'selectable', 'evented', 'lockScalingY', 'splitByGrapheme', 'fixedHeight', 'editable', 'matchHeight', 'autoBackgroundColor', 'textureId', 'textureScale', 'textureRotation', 'textureOpacity', 'snapToObjects', 'logoAutoFix', 'maxItems', 'fullList', 'slotWidth', 'slotHeight']);
    // Filter out fade effects so they aren't saved as static objects
    json.objects = json.objects.filter(o => o.dataTag !== 'fade_effect' && o.dataTag !== 'grid_line' && o.dataTag !== 'guide_overlay' && o.dataTag !== 'separator' && o.dataTag !== 'row_separator');
    // Filter out ambilight background (it is auto-generated)
    json.objects = json.objects.filter(o => o.dataTag !== 'ambilight_bg');

    // Normalize to 1080p base resolution
    const currentScale = canvas.width / BASE_WIDTH;
    if (currentScale !== 1) {
        json.objects.forEach(obj => {
            obj.left /= currentScale;
            obj.top /= currentScale;
            obj.scaleX /= currentScale;
            obj.scaleY /= currentScale;
        });
    }

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
        backgroundMode: backgroundMode // Save the mode
    };
    json.lastFetchedData = lastFetchedData;
    localStorage.setItem('autosave_layout', JSON.stringify(json));
    saveHistory();
}

// Helper: Waits precisely for Font Family AND Weight (Bold/Italic)
// Also forces loading of the base version to support Color Fonts like Bungee Spice
function waitForUsedFonts(canvas) {
    const promises = [];
    const families = new Set();

    const collectFonts = (obj) => {
        if ((obj.type === 'i-text' || obj.type === 'textbox' || obj.type === 'text') && obj.fontFamily) {
            // Load specific style (e.g. "bold 20px Roboto")
            const weight = obj.fontWeight || 'normal';
            const style = obj.fontStyle || 'normal';
            promises.push(document.fonts.load(`${style} ${weight} 20px "${obj.fontFamily}"`));

            families.add(obj.fontFamily);
        }
        // Recursively check groups
        if (obj.type === 'group' && obj.getObjects) {
            obj.getObjects().forEach(collectFonts);
        }
    };

    canvas.getObjects().forEach(collectFonts);

    // Safety Net: ALWAYS load the standard version of the family.
    // Critical for fonts like "Bungee Spice" which only exist as Regular but might be used as Bold.
    families.forEach(family => {
        promises.push(document.fonts.load(`16px "${family}"`));
        promises.push(document.fonts.load(`normal normal 16px "${family}"`));
    });

    return Promise.all(promises);
}

async function loadFromLocalStorage() {
    const saved = localStorage.getItem('autosave_layout');
    if (saved) {
        try {
            const data = JSON.parse(saved);

            if (data.metadata) lastFetchedData = data.metadata;

            // --- STEP 1: Pre-load Fonts (The Fix) ---
            // We identify needed fonts and force the browser to load them BEFORE rendering.
            const neededFonts = extractFontsFromJSON(data);
            if (neededFonts.length > 0) {
                // console.log("Preloading fonts:", neededFonts);
                const fontPromises = neededFonts.flatMap(font => [
                    // Load Regular
                    document.fonts.load(`16px "${font}"`),
                    // Load Bold/Italic variants just to be safe
                    document.fonts.load(`bold 16px "${font}"`),
                    document.fonts.load(`italic 16px "${font}"`)
                ]);

                // Wait here until fonts are ready!
                await Promise.all(fontPromises);
            }
            // ----------------------------------------

            // Scale up to current resolution
            const currentRes = document.getElementById('resSelect').value;
            const targetW = (currentRes === '2160') ? 3840 : 1920;
            const scaleFactor = targetW / BASE_WIDTH;

            if (scaleFactor !== 1) {
                data.objects.forEach(obj => {
                    obj.left *= scaleFactor;
                    obj.top *= scaleFactor;
                    obj.scaleX *= scaleFactor;
                    obj.scaleY *= scaleFactor;
            if (obj.slotWidth) obj.slotWidth *= scaleFactor;
            if (obj.slotHeight) obj.slotHeight *= scaleFactor;
                });
            }

            lastFetchedData = data.lastFetchedData || null;

            // Now it is safe to load the JSON, because fonts are in memory.
            canvas.loadFromJSON(data, () => {
                canvas.getObjects().forEach(o => { if (o.dataTag === 'overview') o.set('objectCaching', false); });

                mainBg = canvas.getObjects().find(o => o.dataTag === 'background');
                const title = canvas.getObjects().find(o => o.dataTag === 'title' && o.type === 'image');
                if (title) {
                    if (!title.slotWidth) title.slotWidth = title.getScaledWidth();
                    if (!title.slotHeight) title.slotHeight = title.getScaledHeight();
                    preferredLogoWidth = title.slotWidth;
                }

                // Cleanup Ghosts
                const ghosts = canvas.getObjects().filter(o =>
                    o.dataTag === 'fade_effect' ||
                    o.dataTag === 'grid_line' ||
                    o.dataTag === 'separator' ||
                    o.dataTag === 'row_separator' ||
                    o.dataTag === 'guide_overlay' ||
                    (o.type === 'rect' && !o.selectable && !o.evented) ||
                    (o.type === 'line' && o.stroke === '#555' && !o.selectable)
                );
                ghosts.forEach(g => canvas.remove(g));

                // Fallback Background
                if (!mainBg && canvas.getObjects().length > 0) {
                    const firstObj = canvas.item(0);
                    if (firstObj && firstObj.type === 'image' && firstObj.width > 500) {
                        mainBg = firstObj;
                        mainBg.set('dataTag', 'background');
                    }
                }
                if (mainBg) mainBg.set({ selectable: true, evented: true });

                if (data.custom_effects) applyCustomEffects(data.custom_effects);

                updateFades();
                updateFadeControls(); // Ensure UI sliders are visible based on loaded mode

                // Final layout adjustment
                // Even though we preloaded, we trigger a recalc just to be 100% sure
                canvas.getObjects().forEach(obj => {
                    if (obj.dataTag === 'overview' && obj.type === 'textbox') {
                        fitTextToContainer(obj);
                    }
                    obj.setCoords();
                });

                updateVerticalLayout();
                canvas.requestRenderAll();

            }, (o, object) => {
                // Gradient Restoration Reviver
                if (object.fill && object.fill.type === 'linear' && object.fill.colorStops && object.fill.colorStops.length > 0) {
                    try {
                        if (object.dataTag === 'fade_effect') {
                            let loadedColor = "#000000";
                            let rawColor = object.fill.colorStops[0].color;
                            if (rawColor && rawColor.startsWith('rgb')) {
                                const rgb = rawColor.match(/\d+/g);
                                if (rgb && rgb.length >= 3) {
                                    loadedColor = "#" +
                                        ("0" + parseInt(rgb[0], 10).toString(16)).slice(-2) +
                                        ("0" + parseInt(rgb[1], 10).toString(16)).slice(-2) +
                                        ("0" + parseInt(rgb[2], 10).toString(16)).slice(-2);
                                }
                            } else if (rawColor && rawColor.startsWith('#')) { loadedColor = rawColor; }
                            const picker = document.getElementById('bgColor');
                            if (picker && loadedColor && picker.value.toLowerCase() !== loadedColor.toLowerCase()) picker.value = loadedColor;
                        }
                        const freshStops = object.fill.colorStops.map(stop => ({ offset: stop.offset, color: stop.color }));
                        object.fill.colorStops = freshStops;
                        object.dirty = true;
                    } catch (e) { console.warn("Gradient restore fail", e); }
                }
            });
            return true;
        } catch (e) { console.error("Autosave load error", e); }
    }
    return false;
}

function toggleLogoAutoFix() {
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'image') {
        activeObj.logoAutoFix = document.getElementById('logoAutoFixToggle').checked;

        // Update global preference
        const batchCheck = document.getElementById('batchLogoAutoFix');
        if (batchCheck) batchCheck.checked = activeObj.logoAutoFix;

        const currentSrc = activeObj.getSrc();
        if (currentSrc.includes('/api/proxy/image')) {
            const urlObj = new URL(currentSrc, window.location.origin);
            if (activeObj.logoAutoFix) {
                urlObj.searchParams.delete('raw');
            } else {
                urlObj.searchParams.set('raw', 'true');
            }

            activeObj.setSrc(urlObj.toString(), function () {
                if (activeObj.filters && activeObj.filters.length > 0) activeObj.applyFilters();
                canvas.renderAll();
                saveToLocalStorage();
            }, { crossOrigin: 'anonymous' });
        } else {
            saveToLocalStorage();
        }
    }
}

function updateLogoBrightness() {
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'image') {
        const val = parseInt(document.getElementById('logoBrightnessInput').value) / 100;
        document.getElementById('logoBrightnessVal').innerText = Math.round(val * 100) + '%';
        if (!activeObj.filters) activeObj.filters = [];
        activeObj.filters = activeObj.filters.filter(f => f.type !== 'Brightness');
        if (val !== 0) activeObj.filters.push(new fabric.Image.filters.Brightness({ brightness: val }));
        activeObj.applyFilters();
        canvas.requestRenderAll();
        saveToLocalStorage();
    }
}

function updateLogoColor() {
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'image') {
        const color = document.getElementById('logoColorInput').value;

        // Clear legacy tint property if present
        if (activeObj.tint) activeObj.set('tint', null);

        if (!activeObj.filters) activeObj.filters = [];
        activeObj.filters = activeObj.filters.filter(f => f.type !== 'BlendColor');

        if (color !== '#ffffff') {
            activeObj.filters.push(new fabric.Image.filters.BlendColor({ color: color, mode: 'tint' }));
        }

        activeObj.applyFilters();
        canvas.requestRenderAll();
        saveToLocalStorage();
    }
}

function resetLogoColor() {
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'image') {
        document.getElementById('logoColorInput').value = "#ffffff";

        if (activeObj.tint) activeObj.set('tint', null);

        if (activeObj.filters) {
            activeObj.filters = activeObj.filters.filter(f => f.type !== 'BlendColor');
            activeObj.applyFilters();
        }

        canvas.requestRenderAll();
        saveToLocalStorage();
    }
}

function toggleTitleType() {
    const activeObj = canvas.getActiveObject();
    if (!activeObj || activeObj.dataTag !== 'title') return;

    if (!lastFetchedData) {
        alert("No media data available.");
        return;
    }

    // Helper to calculate new left position based on alignment to prevent wandering
    const getNewLeft = (newWidth) => {
        const align = document.getElementById('tagAlignSelect').value;
        const oldWidth = activeObj.getScaledWidth();
        const oldLeft = activeObj.left;

        if (align === 'center') {
            return oldLeft + (oldWidth - newWidth) / 2;
        } else if (align === 'right') {
            return oldLeft + (oldWidth - newWidth);
        }
        return oldLeft;
    };

    if (activeObj.type === 'image') {
        // Switch to Text
        const title = lastFetchedData.title || "Title";
        const is4K = document.getElementById('resSelect').value === '2160';
        const titleSize = is4K ? 120 : 80;

        // Preserve slot dimensions
        const slotW = activeObj.slotWidth || activeObj.getScaledWidth();
        const slotH = activeObj.slotHeight || activeObj.getScaledHeight();

        // Calculate max width based on tags
        const tagsW = getTagsMaxWidth();
        let finalW = tagsW > 0 ? tagsW : slotW;

        // Ensure we don't exceed canvas margins
        const marginLeft = parseInt(document.getElementById('marginLeftInput').value) || 50;
        const marginRight = parseInt(document.getElementById('marginRightInput').value) || 50;
        const maxCanvasW = canvas.width - marginLeft - marginRight;
        if (finalW > maxCanvasW) finalW = maxCanvasW;

        const newText = new fabric.IText(title, {
            left: activeObj.left,
            top: activeObj.top,
            fontFamily: 'Roboto',
            fontSize: titleSize,
            fill: 'white',
            shadow: '2px 2px 10px rgba(0,0,0,0.8)',
            dataTag: 'title',
            editable: false,
            logoAutoFix: activeObj.logoAutoFix,
            slotWidth: finalW,
            slotHeight: slotH
        });

        // Shrink & Scale logic (using finalW)
        shrinkTextboxToContent(newText, finalW);
        const scale = Math.min(finalW / newText.width, slotH / newText.height);
        newText.scale(scale);

        // Adjust position based on alignment
        newText.set('left', getNewLeft(newText.getScaledWidth()));

        canvas.remove(activeObj);
        canvas.add(newText);
        canvas.setActiveObject(newText);
        canvas.fire('selection:created'); // Force UI update for Popup
        updateVerticalLayout();
        saveToLocalStorage();
    } else {
        // Switch to Logo
        if (!lastFetchedData.logo_url) {
            alert("No logo available.");
            return;
        }

        // Determine Auto-Fix state (Default to true if undefined)
        const autoFixState = (activeObj.logoAutoFix !== undefined) ? activeObj.logoAutoFix : true;

        let proxiedLogo = `/api/proxy/image?url=${encodeURIComponent(lastFetchedData.logo_url)}`;
        if (!autoFixState) {
            proxiedLogo += "&raw=true";
        }

        fabric.Image.fromURL(proxiedLogo, function (img, isError) {
            if (isError || !img) return;

            // Use slot dimensions for scaling
            const slotW = activeObj.slotWidth || activeObj.getScaledWidth();
            const slotH = activeObj.slotHeight || activeObj.getScaledHeight();

            // Scale to fit within the slot
            let scale = Math.min(slotW / img.width, slotH / img.height);

            img.scale(scale);

            const newLeft = getNewLeft(img.getScaledWidth());
            img.set({ 
                left: newLeft, 
                top: activeObj.top, 
                dataTag: 'title', 
                logoAutoFix: autoFixState,
                slotWidth: slotW,
                slotHeight: slotH
            });

            canvas.remove(activeObj);
            canvas.add(img);
            canvas.setActiveObject(img);
            canvas.fire('selection:created'); // Force UI update for Popup
            updateVerticalLayout();
            saveToLocalStorage();
        }, { crossOrigin: 'anonymous' });
    }
}

function toggleBatchConfig() {
    if (window.innerWidth > 1280) return;
    const content = document.getElementById('batch-config-content');
    const header = document.querySelector('.batch-header');
    if (content && header) {
        content.classList.toggle('active');
        header.classList.toggle('active');
    }
}

function toggleMobileTools() {
    const tools = document.getElementById('toolsDropdown');
    if (tools) {
        tools.classList.toggle('open');
    }
}

function syncLogoAutoFix(val) {
    saveToLocalStorage();
}

// --- CRON JOB MANAGEMENT ---
let currentCronJobs = [];

async function loadCronJobs() {
    // We fetch the full settings to get the cron_jobs list
    // Since there isn't a dedicated GET endpoint for just cron jobs in the provided python code,
    // we assume they are part of the config loaded via template or we can fetch them if we add an endpoint.
    // For now, let's assume we can get them via a new fetch or they are passed in `config` object in HTML.
    // BUT, since I cannot modify the python GET routes easily without seeing them all, 
    // I will rely on the fact that `saveSettings` posts the whole config.
    // To properly load them dynamically, we should probably add a small endpoint or just reload the page.
    // However, to make it dynamic:
    // Let's assume we add a small helper in python or just use the existing config object if available globally.
    // Actually, let's just use the `config` object rendered in the template if possible, 
    // but for dynamic updates (add/delete), we need to fetch.
    // Let's implement a simple fetch from a hypothetical endpoint or just re-use the page load data for now.
    // Wait, I can't add a GET endpoint in python easily in this diff format if I don't see the file.
    // I will assume `config` is available in global scope from the template (it usually is in Flask templates if assigned to window).
    // If not, I will add a fetch to `gui_editor.py` in the next step.
    // For now, let's implement the UI logic assuming `currentCronJobs` is populated.
}

// Actually, let's add the logic to `gui_editor.py` to return settings if needed, 
// but `saveSettings` sends everything.
// Let's implement `addCronJob` which reads the current batch settings.

let logPollInterval = null;

async function clearServerLogs() {
    try {
        await fetch('/api/batch/logs/clear', { method: 'POST' });
        const logDiv = document.getElementById('batchLog');
        if (logDiv) logDiv.innerHTML = '';
    } catch (e) {
        console.error("Failed to clear logs", e);
    }
}

function startLogPolling() {
    if (logPollInterval) clearInterval(logPollInterval);
    const logDiv = document.getElementById('batchLog');
    if (logDiv) {
        logDiv.style.overflowY = 'auto';
        logDiv.innerHTML = "Waiting for server logs...";
    }

    logPollInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/batch/logs');
            const logs = await res.json();

            const selection = window.getSelection();
            const hasSelection = selection.toString().length > 0 && logDiv.contains(selection.anchorNode);

            if (!hasSelection && logs && logs.length > 0 && logDiv) {
                const isAtBottom = logDiv.scrollHeight - logDiv.scrollTop <= logDiv.clientHeight + 50;
                logDiv.innerHTML = logs.join('<br>');
                if (isAtBottom) logDiv.scrollTop = logDiv.scrollHeight;
            }

            // Poll for latest image
            try {
                const imgRes = await fetch('/api/batch/preview/latest_image');
                if (imgRes.ok) {
                    const blob = await imgRes.blob();
                    const url = URL.createObjectURL(blob);
                    const img = document.getElementById('batchPreviewImg');
                    if (img) {
                        if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
                        img.src = url;
                        img.style.opacity = '1';
                    }
                }
            } catch (err) { /* ignore image fetch errors */ }
        } catch (e) { console.error(e); }
    }, 2000);
}

async function addCronJob() {
    const name = document.getElementById('cronJobName').value || "Untitled Job";
    const start = document.getElementById('cronJobStart').value;
    const freq = document.getElementById('cronJobFreq').value;
    const overwrite = document.getElementById('cronJobOverwrite').checked;
    const cleanup = document.getElementById('cronJobCleanup') ? document.getElementById('cronJobCleanup').checked : false;
    const runNow = document.getElementById('cronJobRunNow').checked;

    const layout = document.getElementById('cronJobLayout').value;
    const mode = document.getElementById('cronSourceMode') ? document.getElementById('cronSourceMode').value : 'library';
    const filterMode = document.getElementById('cronFilterMode') ? document.getElementById('cronFilterMode').value : 'all';
    const filterVal = document.getElementById('cronFilterValue') ? document.getElementById('cronFilterValue').value : '';
    const randomCount = document.getElementById('cronRandomCount') ? document.getElementById('cronRandomCount').value : 10;
    const logoAutoFix = document.getElementById('cronLogoAutoFix') ? document.getElementById('cronLogoAutoFix').checked : true;
    const dryRun = document.getElementById('cronDryRun') ? document.getElementById('cronDryRun').checked : false;

    const providers = Array.from(document.querySelectorAll('input[name="cronProvider"]:checked')).map(cb => cb.value);
    const seerrWindow = document.getElementById('cronSeerrWindow') ? document.getElementById('cronSeerrWindow').value : 'week';
    let seerrAvailability = 'all';
    if (['available', 'not_available', 'requestable'].includes(filterMode)) {
        seerrAvailability = filterMode;
    } else if (mode === 'trending') {
        seerrAvailability = filterMode === 'all' ? 'all' : (filterVal || 'all');
    }

    const newJob = {
        id: Date.now().toString(), // Simple ID
        name: name,
        enabled: true,
        start_time: start,
        frequency: freq,
        overwrite: overwrite,
        cleanup: cleanup,
        force_run: runNow,
        layout_name: layout,
        source_mode: mode,
        filter_mode: filterMode,
        filter_value: filterVal,
        random_count: randomCount,
        logo_auto_fix: logoAutoFix,
        dry_run: dryRun,
        item_types: document.getElementById('cronMediaType') ? document.getElementById('cronMediaType').value : 'Movie,Series',
        limit: document.getElementById('cronMaxItems') ? document.getElementById('cronMaxItems').value : '0',
        providers: providers,
        seerr_time_window: seerrWindow,
        seerr_availability: seerrAvailability,
        created_at: new Date().toISOString()
    };


    // Get current config, append job, save
    // We need to fetch current config first to not overwrite other stuff
    // Since we don't have a GET /api/settings, we might rely on the server handling the merge or we need to add GET.
    // I will add a GET /api/settings endpoint to gui_editor.py to make this robust.

    const r = await fetch('/api/settings_full'); // I will add this endpoint
    const config = await r.json();

    if (!config.cron_jobs) config.cron_jobs = [];
    config.cron_jobs.push(newJob);

    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });

    alert("Cron Job Saved!" + (runNow ? " (Running in background...)" : ""));

    if (runNow) {
        startLogPolling();
    }
    renderCronJobs(config.cron_jobs);
}

async function deleteCronJob(id) {
    if (!confirm("Delete this job?")) return;
    const r = await fetch('/api/settings_full');
    const config = await r.json();
    config.cron_jobs = config.cron_jobs.filter(j => j.id !== id);
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    renderCronJobs(config.cron_jobs);
}

async function stopCronJobs() {
    if (!confirm("Stop all running cron jobs? This will terminate the background process.")) return;
    try {
        const r = await fetch('/api/cron/stop', { method: 'POST' });
        const res = await r.json();
        alert(res.message);
    } catch (e) {
        console.error(e);
        alert("Failed to send stop signal");
    }
}

function renderCronJobs(jobs) {
    const list = document.getElementById('cronJobsList');
    list.innerHTML = '';

    // Add Stop Button Area
    const controls = document.createElement('div');
    controls.style.cssText = "display:flex; justify-content:flex-end; margin-bottom:10px;";
    controls.innerHTML = `<button onclick="stopCronJobs()" style="background:#d32f2f; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:12px; display:flex; align-items:center;"><span style="margin-right:5px;">🛑</span> Stop All Jobs</button>`;
    list.appendChild(controls);

    if (!jobs || jobs.length === 0) {
        const msg = document.createElement('div');
        msg.style.cssText = 'color:#888; font-size:11px; padding:5px;';
        msg.innerText = 'No active jobs.';
        list.appendChild(msg);
        return;
    }

    jobs.forEach(job => {
        let freqDisplay = `${job.frequency}x/day`;
        if (job.frequency === 'weekly') freqDisplay = 'Weekly';
        else if (job.frequency === 'monthly') freqDisplay = 'Monthly';

        const item = document.createElement('div');
        item.style.cssText = "background:rgba(255,255,255,0.05); padding:8px; border-radius:4px; border:1px solid #444; display:flex; justify-content:space-between; align-items:center;";
        item.innerHTML = `
            <div>
                <div style="font-weight:bold; font-size:12px; color:#fff;">${job.name}</div>
                <div style="font-size:10px; color:#aaa;">${job.layout_name} • ${job.start_time} • ${freqDisplay}</div>
                <div style="font-size:10px; color:#888;">${job.overwrite ? 'Overwrite: On' : 'Overwrite: Off'} • ${job.cleanup ? 'Cleanup: On' : 'Cleanup: Off'}</div>
            </div>
            <button onclick="deleteCronJob('${job.id}')" style="background:#c62828; border:none; color:white; padding:4px 8px; border-radius:3px; cursor:pointer; font-size:10px;">Del</button>
        `;
        list.appendChild(item);
    });
}

// Initial load wrapper
async function loadCronJobs() {
    try {
        const r = await fetch('/api/settings_full');
        if (r.ok) {
            const config = await r.json();
            renderCronJobs(config.cron_jobs);
        }
        await loadCronLayoutOptions();
    } catch (e) { console.log("Could not load cron jobs"); }
}

async function loadCronLayoutOptions() {
    const select = document.getElementById('cronJobLayout');
    if (!select) return;
    try {
        const resp = await fetch('/api/layouts/list');
        const layouts = await resp.json();
        select.innerHTML = '';
        layouts.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l;
            opt.innerText = l;
            select.appendChild(opt);
        });
        const current = document.getElementById('layoutName').value;
        if (layouts.includes(current)) select.value = current;
    } catch (e) { console.error("Error loading cron layouts", e); }
}

function injectCronFilterUI() {
    const layoutSelect = document.getElementById('cronJobLayout');
    if (!layoutSelect || document.getElementById('cronFilterContainer')) return;

    const container = document.createElement('div');
    container.id = 'cronFilterContainer';
    container.style.marginTop = '10px';
    container.innerHTML = `
        <label style="display:block; color:#aaa; font-size:12px; margin-bottom:5px;">Source Mode</label>
        <select id="cronSourceMode" style="width:100%; background:#333; color:#fff; border:1px solid #555; padding:5px; margin-bottom:10px;" onchange="toggleCronInputs()">
            <option value="library" selected>Library (All Items)</option>
            <option value="random">Random Selection</option>
            <option value="trending">Trending (Seerr)</option>
        </select>
        
        <div id="cronFilterSettings">
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <div style="flex:1;">
                    <label style="display:block; color:#aaa; font-size:12px; margin-bottom:5px;">Media Type</label>
                    <select id="cronMediaType" style="width:100%; background:#333; color:#fff; border:1px solid #555; padding:5px;">
                        <option value="Movie,Series" selected>All</option>
                        <option value="Movie">Movies</option>
                        <option value="Series">Series</option>
                    </select>
                </div>
                <div style="flex:1;">
                    <label style="display:block; color:#aaa; font-size:12px; margin-bottom:5px;">Limit (0=All)</label>
                    <input type="number" id="cronMaxItems" value="0" min="0" style="width:100%; background:#333; color:#fff; border:1px solid #555; padding:5px;">
                </div>
            </div>

            <label style="display:block; color:#aaa; font-size:12px; margin-bottom:5px;">Filter</label>
            <select id="cronFilterMode" style="width:100%; background:#333; color:#fff; border:1px solid #555; padding:5px; margin-bottom:10px;" onchange="toggleCronInputs()">
                <option value="all" selected>All Items</option>
                <option value="recent">Recently Added</option>
                <option value="year">By Year</option>
                <option value="genre">By Genre</option>
                <option value="rating">By Rating</option>
                <option value="missing">Missing / Wanted (Radarr/Sonarr)</option>
                <option value="available">Seerr: Available</option>
                <option value="not_available">Seerr: Not in library</option>
                <option value="requestable">Seerr: Requestable</option>
            </select>

            <div id="cronSeerrOptions" style="display:none; margin-bottom:10px;">
                <label style="display:block; color:#aaa; font-size:12px; margin-bottom:5px;">Seerr trending window</label>
                <select id="cronSeerrWindow" style="width:100%; background:#333; color:#fff; border:1px solid #555; padding:5px;">
                    <option value="week" selected>Week</option>
                    <option value="day">Day</option>
                </select>
            </div>
            
            <input type="text" id="cronFilterValue" placeholder="Value (e.g. 2023 or Action)" style="width:100%; background:#333; color:#fff; border:1px solid #555; padding:5px; margin-bottom:10px; display:none;">
        </div>
        
        <div id="cronRandomSettings" style="display:none;">
            <label style="display:block; color:#aaa; font-size:12px; margin-bottom:5px;">Count</label>
            <input type="number" id="cronRandomCount" value="10" style="width:100%; background:#333; color:#fff; border:1px solid #555; padding:5px; margin-bottom:10px;">
        </div>
    `;

    layoutSelect.parentNode.insertBefore(container, layoutSelect.nextSibling);

    // Inject Checkboxes (Auto Fix, Dry Run) grouped with existing checkboxes
    const runNowCb = document.getElementById('cronJobRunNow');
    let targetParent = container;
    let targetSibling = null;

    // Try to find the "Run Now" checkbox to place ours nearby
    if (runNowCb) {
        let ref = runNowCb;
        // Traverse up to find the label or container
        while (ref && ref.tagName !== 'LABEL' && ref.parentNode !== layoutSelect.parentNode) {
            ref = ref.parentNode;
        }
        if (ref && (ref.tagName === 'LABEL' || ref.parentNode === layoutSelect.parentNode)) {
            targetParent = ref.parentNode;
            targetSibling = ref.nextSibling;
        }
    }

    const checkboxesDiv = document.createElement('div');

    const createCb = (id, labelText, isChecked) => {
        const label = document.createElement('label');
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.color = '#fff';
        label.style.fontSize = '12px';
        label.style.marginBottom = '5px';
        label.style.cursor = 'pointer';
        label.style.marginTop = '5px';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = isChecked;

        // Copy styles from reference checkbox (Run Immediately) to match size exactly
        if (runNowCb) {
            if (runNowCb.className) input.className = runNowCb.className;
            if (runNowCb.style.cssText) input.style.cssText = runNowCb.style.cssText;
        }
        input.style.marginRight = '5px'; // Ensure spacing

        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + labelText));
        return label;
    };

    checkboxesDiv.appendChild(createCb('cronLogoAutoFix', 'Auto Fix Logo Color', false));
    checkboxesDiv.appendChild(createCb('cronDryRun', 'Dry Run (Log only)', false));

    if (targetSibling) {
        targetParent.insertBefore(checkboxesDiv, targetSibling);
    } else {
        targetParent.appendChild(checkboxesDiv);
    }

    // Default: Run Immediately = ON
    if (runNowCb) runNowCb.checked = true;

    // Default: No providers selected
    const providers = document.querySelectorAll('input[name="cronProvider"]');
    providers.forEach(cb => cb.checked = false);
}

function updateCronFrequencyOptions() {
    const select = document.getElementById('cronJobFreq');
    if (!select) return;
    
    if (!select.querySelector('option[value="weekly"]')) {
        const opt = document.createElement('option');
        opt.value = 'weekly';
        opt.innerText = 'Weekly (Monday)';
        select.appendChild(opt);
    }
    if (!select.querySelector('option[value="monthly"]')) {
        const opt = document.createElement('option');
        opt.value = 'monthly';
        opt.innerText = 'Monthly (1st)';
        select.appendChild(opt);
    }
}

function toggleCronInputs() {
    const mode = document.getElementById('cronSourceMode').value;
    const filter = document.getElementById('cronFilterMode').value;

    document.getElementById('cronFilterSettings').style.display = (mode === 'library') ? 'block' : 'none';
    document.getElementById('cronRandomSettings').style.display = (mode === 'random') ? 'block' : 'none';

    const valInput = document.getElementById('cronFilterValue');
    if (mode === 'library' && ['year', 'genre', 'rating'].includes(filter)) {
        valInput.style.display = 'block';
        if (filter === 'year') valInput.placeholder = "Year (e.g. 2023)";
        if (filter === 'genre') valInput.placeholder = "Genre (e.g. Action)";
        if (filter === 'rating') valInput.placeholder = "Min Rating (e.g. 8.0)";
    } else {
        valInput.style.display = 'none';
    }
}

window.onload = init;

// Max Items Logic
function updateMaxItems() {
    const activeObj = canvas.getActiveObject();
    if (!activeObj || (activeObj.dataTag !== 'actors' && activeObj.dataTag !== 'directors')) return;

    // Get value from either slider (Ribbon or Floating)
    // We'll use the one that triggered the event, or default to the ribbon one if called programmatically without event
    const ribbonSlider = document.getElementById('maxItemsSlider');
    const propSlider = document.getElementById('prop-max-items');

    // Sync values
    let newVal = ribbonSlider.value;
    if (event && event.target === propSlider) {
        newVal = propSlider.value;
        ribbonSlider.value = newVal;
    } else {
        if (propSlider) propSlider.value = newVal;
    }

    // Update UI labels
    document.getElementById('maxItemsVal').innerText = newVal;
    if (document.getElementById('prop-max-items-val')) {
        document.getElementById('prop-max-items-val').innerText = newVal;
    }

    // Update Object
    activeObj.set('maxItems', parseInt(newVal));

    // Refetch/Update Text content based on new limit
    // We rely on the full list stored in 'fullList' if available, or just re-request preview
    if (activeObj.fullList) {
        let listToUse = activeObj.fullList;
        // Check if listToUse is a string (comma separated) or array
        if (typeof listToUse === 'string') {
            listToUse = listToUse.split(',').map(s => s.trim());
        }

        const sliced = listToUse.slice(0, newVal);
        const prefix = activeObj.dataTag === 'directors' ? "Dir: " : "";
        activeObj.set('text', prefix + sliced.join(', '));
    }

    canvas.requestRenderAll();
}

// Add event listener for floating menu slider if it exists
const propMaxItemsSlider = document.getElementById('prop-max-items');
if (propMaxItemsSlider) {
    propMaxItemsSlider.addEventListener('input', updateMaxItems);
}

function setSeparatorFromSelect(val) {
    const input = document.getElementById('tagSeparatorInput');
    if (input) {
        input.value = val;
        updateVerticalLayout();
        saveToLocalStorage();
    }
}

function updateSeparatorSize() {
    const val = document.getElementById('tagSeparatorSizeInput').value;
    document.getElementById('tagSeparatorSizeVal').innerText = val + "px";
    updateVerticalLayout();
    saveToLocalStorage();
}

function updateSeparatorOpacity() {
    const val = document.getElementById('tagSeparatorOpacityInput').value;
    document.getElementById('tagSeparatorOpacityVal').innerText = val + "%";
    updateVerticalLayout();
    saveToLocalStorage();
}

function updateRowSeparatorOpacity() {
    const val = document.getElementById('rowSeparatorOpacityInput').value;
    document.getElementById('rowSeparatorOpacityVal').innerText = val + "%";
    updateVerticalLayout();
    saveToLocalStorage();
}

function updateRowSeparatorTexture() {
    const textureId = document.getElementById('rowSeparatorTextureSelect').value;
    if (!textureId) {
        rowSeparatorTextureImg = null;
        updateVerticalLayout();
        saveToLocalStorage();
        return;
    }

    const profile = textureProfiles.find(p => p.id === textureId);
    if (!profile) return;

    const url = `/api/textures/image/${profile.filename}`;
    fabric.util.loadImage(url, function (img) {
        rowSeparatorTextureImg = img;
        updateVerticalLayout();
        saveToLocalStorage();
    });
}

function updateSeparatorTexture() {
    const textureId = document.getElementById('tagSeparatorTextureSelect').value;
    if (!textureId) {
        separatorTextureImg = null;
        updateVerticalLayout();
        saveToLocalStorage();
        return;
    }

    const profile = textureProfiles.find(p => p.id === textureId);
    if (!profile) return;

    const url = `/api/textures/image/${profile.filename}`;
    fabric.util.loadImage(url, function (img) {
        separatorTextureImg = img;
        updateVerticalLayout();
        saveToLocalStorage();
    });
}

// Update loadTextureProfiles to populate separator select
const originalLoadTextureProfiles = loadTextureProfiles;
loadTextureProfiles = async function () {
    await originalLoadTextureProfiles();
    const sel = document.getElementById('tagSeparatorTextureSelect');
    if (sel) {
        const selRow = document.getElementById('rowSeparatorTextureSelect');
        const current = sel.value;
        const currentRow = selRow ? selRow.value : '';
        sel.innerHTML = '<option value="">No Texture</option>';
        if (selRow) selRow.innerHTML = '<option value="">No Texture</option>';
        textureProfiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.innerText = p.name;
            sel.appendChild(opt);
            if (selRow) selRow.appendChild(opt.cloneNode(true));
        });
        sel.value = current;
        if (selRow) selRow.value = currentRow;
    }
};

function updateRowSeparatorThickness() {
    const val = document.getElementById('rowSeparatorThickness').value;
    document.getElementById('rowSeparatorThicknessVal').innerText = val + "px";
    updateVerticalLayout();
    saveToLocalStorage();
}

function toggleRowSeparatorWidthControl() {
    const auto = document.getElementById('rowSeparatorAutoWidth').checked;
    document.getElementById('rowSeparatorWidthControl').style.display = auto ? 'none' : 'block';
}

function updateRowSeparatorWidth() {
    const val = document.getElementById('rowSeparatorWidth').value;
    document.getElementById('rowSeparatorWidthVal').innerText = val + "px";
    updateVerticalLayout();
    saveToLocalStorage();
}

// --- OMDb Integration ---

// 1. Settings Management (Merged with API)
async function saveSettings() {
    const config = {
        jellyfin: {
            url: document.getElementById('set-jf-url').value,
            api_key: document.getElementById('set-jf-key').value,
            user_id: document.getElementById('set-jf-user').value,
            excluded_libraries: document.getElementById('set-jf-exclude').value
        },
        plex: {
            url: document.getElementById('set-plex-url').value,
            token: document.getElementById('set-plex-token').value
        },
        tmdb: {
            api_key: document.getElementById('set-tmdb-key').value,
            language: document.getElementById('set-tmdb-lang').value
        },
        omdb: {
            api_key: document.getElementById('set-omdb-key').value
        },
        radarr: {
            url: document.getElementById('set-radarr-url').value,
            api_key: document.getElementById('set-radarr-key').value
        },
        sonarr: {
            url: document.getElementById('set-sonarr-url').value,
            api_key: document.getElementById('set-sonarr-key').value
        },
        jellyseerr: {
            url: document.getElementById('set-jellyseerr-url').value,
            api_key: document.getElementById('set-jellyseerr-key').value,
            trending_window: (document.getElementById('set-jellyseerr-window') || {}).value || 'week',
            default_request_seasons: 'all'
        },
        trakt: {
            api_key: document.getElementById('set-trakt-key').value,
            username: document.getElementById('set-trakt-user').value,
            listname: document.getElementById('set-trakt-list').value
        }
    };

    try {
        const r = await fetch('/api/settings_full');
        if (r.ok) {
            const currentConfig = await r.json();
            Object.assign(currentConfig.jellyfin, config.jellyfin);
            Object.assign(currentConfig.plex, config.plex);
            Object.assign(currentConfig.tmdb, config.tmdb);
            currentConfig.omdb = config.omdb;
            Object.assign(currentConfig.radarr, config.radarr);
            Object.assign(currentConfig.sonarr, config.sonarr);
            Object.assign(currentConfig.jellyseerr, config.jellyseerr);
            Object.assign(currentConfig.trakt, config.trakt);

            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentConfig)
            });
            alert("Settings Saved!");
        } else {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            alert("Settings Saved (Fallback Mode)!");
        }
    } catch (e) {
        console.error("Error saving settings:", e);
        alert("Failed to save settings.");
    }
}

// 2. API Service & Caching
const OMDB_CACHE_KEY_PREFIX = 'omdb_cache_';
const OMDB_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 Days

async function fetchOmdbData(imdbId) {
    if (!imdbId) return null;

    // Check Cache
    const cacheKey = OMDB_CACHE_KEY_PREFIX + imdbId;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        try {
            const entry = JSON.parse(cached);
            if (Date.now() - entry.timestamp < OMDB_CACHE_TTL) {
                console.log(`[OMDb] Serving ${imdbId} from cache.`);
                return entry.data;
            }
        } catch (e) { localStorage.removeItem(cacheKey); }
    }

    // Get API Key
    const apiKeyElement = document.getElementById('set-omdb-key');
    const apiKey = apiKeyElement ? apiKeyElement.value : null;

    if (!apiKey) {
        console.warn("[OMDb] No API Key configured.");
        return null;
    }

    // Fetch from API
    try {
        console.log(`[OMDb] Fetching data for ${imdbId}...`);
        const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}&plot=full`);
        const data = await res.json();

        if (data.Response === "False") {
            console.warn("[OMDb] API Error:", data.Error);
            return null;
        }

        localStorage.setItem(cacheKey, JSON.stringify({
            timestamp: Date.now(),
            data: data
        }));

        return data;

    } catch (e) {
        console.error("[OMDb] Network Error:", e);
        return null;
    }
}

// 3. Data Mapping & Cleaning
function mapOmdbToTags(data) {
    if (!data) return {};

    const getRating = (source) => {
        if (!data.Ratings) return null;
        const r = data.Ratings.find(x => x.Source === source);
        if (!r) return null;
        if (source === 'Rotten Tomatoes') return r.Value.replace('%', '');
        if (source === 'Metacritic') return r.Value.split('/')[0];
        return r.Value;
    };

    const cleanWriters = (writersStr) => {
        if (!writersStr || writersStr === "N/A") return "";
        return writersStr.split(',').map(w => {
            return w.replace(/\s*\(.*?\)\s*/g, '').trim();
        }).join(', ');
    };

    return {
        awards: data.Awards !== "N/A" ? data.Awards : "",
        country: data.Country !== "N/A" ? data.Country : "",
        rated: data.Rated !== "N/A" ? data.Rated : "",
        writer: cleanWriters(data.Writer),
        rotten_tomatoes: getRating('Rotten Tomatoes'),
        metacritic: getRating('Metacritic'),
        imdb_rating: data.imdbRating !== "N/A" ? data.imdbRating : "",
        box_office: data.BoxOffice !== "N/A" ? data.BoxOffice : "",
        plot_full: data.Plot !== "N/A" ? data.Plot : ""
    };
}

// 4. Tag Implementation
async function addOmdbTag(type) {
    let imdbId = lastFetchedData ? lastFetchedData.imdb_id : null;

    // Try to find IMDb ID in external_ids if not at root
    if (!imdbId && lastFetchedData && lastFetchedData.external_ids) {
        imdbId = lastFetchedData.external_ids.imdb_id;
    }

    // Default to mock data immediately if no ID (Empty Canvas case)
    if (!imdbId) {
        console.log("No IMDb ID, using defaults.");
    }

    // Allow creating tag even if fetch failed (Default values)
    let omdbData = null;
    if (imdbId) {
        omdbData = await fetchOmdbData(imdbId);
    }

    // Always fallback to default if no data, permitting creation on empty canvas
    if (!omdbData) {
        console.warn("Using default OMDb values.");
        // Mock data for defaults
        omdbData = { Ratings: [], Response: "True" };
    }

    const tags = mapOmdbToTags(omdbData);
    let value = tags[type];

    if (!value) {
        // Use Placeholder if no data found but user specifically requested the tag
        value = "99";
    }

    const is4K = document.getElementById('resSelect').value === '2160';
    const baseSize = is4K ? 54 : 35;

    // Badge Logic (Logos)
    if (type === 'rotten_tomatoes' || type === 'metacritic') {
        let logoUrl = '';
        let label = '';
        let dataTag = 'omdb_' + type;

        if (type === 'rotten_tomatoes') {
            logoUrl = '/static/provider_logos/rottentomatos.png';
            label = value + '%';
        } else {
            logoUrl = '/static/provider_logos/metacritic.png';
            label = value;
        }

        fabric.Image.fromURL(logoUrl, function (img) {
            if (!img) return;

            const text = new fabric.IText(label, {
                fontFamily: 'Roboto',
                fontSize: baseSize,
                fill: 'white',
                editable: false,
                shadow: '2px 2px 5px rgba(0,0,0,0.5)'
            });

            // Scale logo to match text height
            const textHeight = text.getScaledHeight();
            img.scaleToHeight(textHeight * 1.0);

            // Layout: Logo | Text (Top Aligned)
            img.set({ left: 0, top: 0 });
            text.set({
                left: img.getScaledWidth() + 15,
                top: 0
            });

            const group = new fabric.Group([img, text], {
                left: 100,
                top: 100,
                originX: 'left',
                originY: 'top',
                dataTag: dataTag,
                logoVariant: 0
            });

            canvas.add(group);
            canvas.setActiveObject(group);
            updateVerticalLayout();
            saveToLocalStorage();
        });
        return;
    }

    // Long Plot (Constraint)
    if (type === 'plot_full') {
        const textObj = new fabric.Textbox(value, {
            left: 100,
            top: 300,
            width: canvas.width * 0.5,
            fontFamily: 'Roboto',
            fontSize: baseSize,
            fill: 'white',
            shadow: '2px 2px 10px rgba(0,0,0,0.8)',
            dataTag: 'omdb_plot',
            splitByGrapheme: false,
            editable: false
        });
        fitTextToContainer(textObj); // Use existing helper if available
        canvas.add(textObj);
        canvas.setActiveObject(textObj);
        updateVerticalLayout();
        saveToLocalStorage();
        return;
    }

    addMetadataTag('omdb_' + type, value);
}

// --- OMDb Logo Switch ---
function toggleRTLogo() {
    if (!canvas) return;
    const activeObj = canvas.getActiveObject();
    if (!activeObj || activeObj.dataTag !== 'omdb_rotten_tomatoes') return;

    // Toggle variant
    const currentVariant = activeObj.logoVariant || 0;
    const newVariant = (currentVariant === 0) ? 1 : 0;
    activeObj.logoVariant = newVariant;

    // Update Image Source
    const imgObj = activeObj.getObjects().find(o => o.type === 'image');
    if (imgObj) {
        // Variant 0: rottentomatos.png (Rotten)
        // Variant 1: rottentomatos2.png (Fresh)
        const newSrc = newVariant === 0 ? '/static/provider_logos/rottentomatos.png' : '/static/provider_logos/rottentomatos2.png';

        imgObj.setSrc(newSrc, function () {
            // Re-render and update layout if needed
            const textObj = activeObj.getObjects().find(o => o.type === 'i-text');
            if (textObj) {
                const textHeight = textObj.getScaledHeight();
                imgObj.scaleToHeight(textHeight * 1.0);
                imgObj.set({ left: 0, top: 0 });
                textObj.set({ left: imgObj.getScaledWidth() + 15, top: 0 }); // Top Aligned

                activeObj.addWithUpdate();
                canvas.requestRenderAll();
                saveToLocalStorage();
            }
        });
    }
}