// ==UserScript==
// @name         Enscriber - Playwright Automation Note-Taking Tool
// @namespace    https://github.com/enscriber
// @version      1.0.0
// @description  Record website interactions for Playwright script generation with intelligent element detection
// @author       Enscriber Team
// @match        *://*/*
// @exclude      *://localhost:*/enscriber/*
// @exclude      *://127.0.0.1:*/enscriber/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/enscriber/enscriber/main/enscriber.user.js
// @downloadURL  https://raw.githubusercontent.com/enscriber/enscriber/main/enscriber.user.js
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================================
    // CONSTANTS AND CONFIGURATION
    // ============================================================================

    const ENSCRIBER_CONFIG = {
        version: '1.0.0',
        namespace: 'enscriber',
        ui: {
            panelId: 'enscriber-floating-panel',
            shadowRootId: 'enscriber-shadow-root',
            minWidth: 300,
            minHeight: 400,
            maxWidth: 800,
            maxHeight: 600,
            defaultWidth: 400,
            defaultHeight: 500,
            zIndex: 999999
        },
        storage: {
            prefix: 'enscriber_',
            sessionKey: 'current_session',
            settingsKey: 'settings'
        },
        modes: {
            INACTIVE: 'inactive',
            AUTO_RECORDING: 'auto_recording',
            MANUAL_SELECTION: 'manual_selection',
            PAUSED: 'paused'
        }
    };

    // ============================================================================
    // DATA MODELS AND INTERFACES
    // ============================================================================

    /**
     * @typedef {Object} ActionRecord
     * @property {string} id - Unique identifier for the action
     * @property {number} timestamp - Unix timestamp when action occurred
     * @property {string} type - Type of action (click, input, etc.)
     * @property {ElementMetadata} element - Metadata about the target element
     * @property {string} [value] - Value associated with the action
     * @property {string} [notes] - User-added notes
     * @property {string} [screenshot] - Base64 encoded screenshot
     * @property {ContextInfo} context - Context information
     */

    /**
     * @typedef {Object} ElementMetadata
     * @property {SelectorSet} selectors - Generated selectors for the element
     * @property {Object} attributes - Element attributes
     * @property {string} textContent - Text content of the element
     * @property {DOMRect} position - Element position and dimensions
     * @property {string} tagName - HTML tag name
     * @property {boolean} isVisible - Whether element is visible
     * @property {Object} computedStyles - Relevant computed styles
     */

    /**
     * @typedef {Object} SelectorSet
     * @property {string[]} css - CSS selectors
     * @property {string[]} xpath - XPath selectors
     * @property {string[]} dataAttributes - Data attribute selectors
     * @property {string[]} textBased - Text-based selectors
     * @property {string[]} role - ARIA role selectors
     * @property {SelectorConfidence} confidence - Confidence scores
     */

    /**
     * @typedef {Object} SessionData
     * @property {string} id - Session identifier
     * @property {string} name - Session name
     * @property {string} url - Current URL
     * @property {number} startTime - Session start timestamp
     * @property {number} [endTime] - Session end timestamp
     * @property {ActionRecord[]} actions - Recorded actions
     * @property {Object} settings - Session settings
     * @property {Object} metadata - Additional metadata
     */

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    /**
     * Utility functions for DOM manipulation, CSS injection, and event handling
     */
    class EnscribeUtils {
        /**
         * Generate a unique identifier
         * @returns {string} Unique ID
         */
        static generateId() {
            return `${ENSCRIBER_CONFIG.namespace}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        /**
         * Safely inject CSS into the document
         * @param {string} css - CSS string to inject
         * @param {string} [id] - Optional ID for the style element
         * @returns {HTMLStyleElement} The created style element
         */
        static injectCSS(css, id = null) {
            const style = document.createElement('style');
            style.type = 'text/css';
            if (id) style.id = id;
            style.textContent = css;
            
            // Try to append to head, fallback to document
            const target = document.head || document.documentElement;
            target.appendChild(style);
            
            return style;
        }

        /**
         * Create a namespaced event name
         * @param {string} eventName - Base event name
         * @returns {string} Namespaced event name
         */
        static createEventName(eventName) {
            return `${ENSCRIBER_CONFIG.namespace}:${eventName}`;
        }

        /**
         * Safely get element position and dimensions
         * @param {Element} element - Target element
         * @returns {DOMRect} Element bounds
         */
        static getElementBounds(element) {
            try {
                return element.getBoundingClientRect();
            } catch (error) {
                console.warn('Enscriber: Could not get element bounds', error);
                return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
            }
        }

        /**
         * Check if element is visible
         * @param {Element} element - Target element
         * @returns {boolean} Whether element is visible
         */
        static isElementVisible(element) {
            if (!element) return false;
            
            const style = window.getComputedStyle(element);
            const bounds = this.getElementBounds(element);
            
            return style.display !== 'none' &&
                   style.visibility !== 'hidden' &&
                   style.opacity !== '0' &&
                   bounds.width > 0 &&
                   bounds.height > 0;
        }

        /**
         * Throttle function execution
         * @param {Function} func - Function to throttle
         * @param {number} delay - Delay in milliseconds
         * @returns {Function} Throttled function
         */
        static throttle(func, delay) {
            let timeoutId;
            let lastExecTime = 0;
            
            return function(...args) {
                const currentTime = Date.now();
                
                if (currentTime - lastExecTime > delay) {
                    func.apply(this, args);
                    lastExecTime = currentTime;
                } else {
                    clearTimeout(timeoutId);
                    timeoutId = setTimeout(() => {
                        func.apply(this, args);
                        lastExecTime = Date.now();
                    }, delay - (currentTime - lastExecTime));
                }
            };
        }

        /**
         * Debounce function execution
         * @param {Function} func - Function to debounce
         * @param {number} delay - Delay in milliseconds
         * @returns {Function} Debounced function
         */
        static debounce(func, delay) {
            let timeoutId;
            
            return function(...args) {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => func.apply(this, args), delay);
            };
        }
    }

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================

    /**
     * Centralized state management for the application
     */
    class StateManager {
        constructor() {
            this.state = {
                mode: ENSCRIBER_CONFIG.modes.INACTIVE,
                isRecording: false,
                isPaused: false,
                currentSession: null,
                ui: {
                    panelVisible: false,
                    panelPosition: { x: 20, y: 20 },
                    panelSize: { 
                        width: ENSCRIBER_CONFIG.ui.defaultWidth, 
                        height: ENSCRIBER_CONFIG.ui.defaultHeight 
                    },
                    isCollapsed: false,
                    isDragging: false,
                    isResizing: false
                },
                settings: {
                    autoSave: true,
                    highlightElements: true,
                    showTooltips: true,
                    recordingMode: 'auto'
                }
            };
            
            this.listeners = new Map();
            this.loadState();
        }

        /**
         * Get current state
         * @returns {Object} Current state
         */
        getState() {
            return { ...this.state };
        }

        /**
         * Update state and notify listeners
         * @param {Object} updates - State updates
         */
        setState(updates) {
            const previousState = { ...this.state };
            this.state = { ...this.state, ...updates };
            
            // Notify listeners of state changes
            this.notifyListeners(previousState, this.state);
            
            // Auto-save if enabled
            if (this.state.settings.autoSave) {
                this.saveState();
            }
        }

        /**
         * Update nested state properties
         * @param {string} path - Dot notation path (e.g., 'ui.panelPosition')
         * @param {*} value - New value
         */
        setNestedState(path, value) {
            const keys = path.split('.');
            const updates = {};
            let current = updates;
            
            for (let i = 0; i < keys.length - 1; i++) {
                current[keys[i]] = { ...this.state[keys[i]] };
                current = current[keys[i]];
            }
            
            current[keys[keys.length - 1]] = value;
            this.setState(updates);
        }

        /**
         * Add state change listener
         * @param {string} key - Listener key
         * @param {Function} callback - Callback function
         */
        addListener(key, callback) {
            if (!this.listeners.has(key)) {
                this.listeners.set(key, []);
            }
            this.listeners.get(key).push(callback);
        }

        /**
         * Remove state change listener
         * @param {string} key - Listener key
         * @param {Function} callback - Callback function to remove
         */
        removeListener(key, callback) {
            if (this.listeners.has(key)) {
                const callbacks = this.listeners.get(key);
                const index = callbacks.indexOf(callback);
                if (index > -1) {
                    callbacks.splice(index, 1);
                }
            }
        }

        /**
         * Notify all listeners of state changes
         * @param {Object} previousState - Previous state
         * @param {Object} newState - New state
         */
        notifyListeners(previousState, newState) {
            this.listeners.forEach((callbacks, key) => {
                callbacks.forEach(callback => {
                    try {
                        callback(newState, previousState);
                    } catch (error) {
                        console.error(`Enscriber: Error in state listener ${key}:`, error);
                    }
                });
            });
        }

        /**
         * Save state to storage
         */
        saveState() {
            try {
                const stateToSave = {
                    ui: this.state.ui,
                    settings: this.state.settings
                };
                GM_setValue(ENSCRIBER_CONFIG.storage.settingsKey, JSON.stringify(stateToSave));
            } catch (error) {
                console.error('Enscriber: Failed to save state:', error);
            }
        }

        /**
         * Load state from storage
         */
        loadState() {
            try {
                const savedState = GM_getValue(ENSCRIBER_CONFIG.storage.settingsKey);
                if (savedState) {
                    const parsed = JSON.parse(savedState);
                    this.state = { ...this.state, ...parsed };
                }
            } catch (error) {
                console.error('Enscriber: Failed to load state:', error);
            }
        }
    }

    // ============================================================================
    // ELEMENT HIGHLIGHTING SYSTEM
    // ============================================================================

    /**
     * Manages visual highlighting of elements on the page
     */
    class ElementHighlighter {
        constructor() {
            this.highlightOverlay = null;
            this.currentElement = null;
            this.highlightStyles = {
                hover: {
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    border: '2px solid #3b82f6',
                    boxShadow: '0 0 0 2px rgba(59, 130, 246, 0.3)'
                },
                selected: {
                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                    border: '2px solid #22c55e',
                    boxShadow: '0 0 0 2px rgba(34, 197, 94, 0.3)'
                },
                recording: {
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    border: '2px solid #ef4444',
                    boxShadow: '0 0 0 2px rgba(239, 68, 68, 0.3)'
                }
            };
            
            this.createHighlightOverlay();
            this.setupScrollListener();
        }

        /**
         * Create the highlight overlay element
         */
        createHighlightOverlay() {
            this.highlightOverlay = document.createElement('div');
            this.highlightOverlay.id = 'enscriber-highlight-overlay';
            this.highlightOverlay.style.cssText = `
                position: absolute;
                pointer-events: none;
                z-index: ${ENSCRIBER_CONFIG.ui.zIndex - 1};
                border-radius: 4px;
                transition: all 0.15s ease-out;
                display: none;
            `;
            
            document.body.appendChild(this.highlightOverlay);
        }

        /**
         * Highlight an element with the specified style
         * @param {Element} element - Element to highlight
         * @param {string} style - Style type ('hover', 'selected', 'recording')
         */
        highlightElement(element, style = 'hover') {
            if (!element || !EnscribeUtils.isElementVisible(element)) {
                this.hideHighlight();
                return;
            }

            const bounds = EnscribeUtils.getElementBounds(element);
            const styleConfig = this.highlightStyles[style] || this.highlightStyles.hover;
            
            // Update overlay position and style
            this.highlightOverlay.style.cssText = `
                position: absolute;
                pointer-events: none;
                z-index: ${ENSCRIBER_CONFIG.ui.zIndex - 1};
                border-radius: 4px;
                transition: all 0.15s ease-out;
                display: block;
                left: ${bounds.left + window.scrollX}px;
                top: ${bounds.top + window.scrollY}px;
                width: ${bounds.width}px;
                height: ${bounds.height}px;
                background-color: ${styleConfig.backgroundColor};
                border: ${styleConfig.border};
                box-shadow: ${styleConfig.boxShadow};
            `;
            
            this.currentElement = element;
        }

        /**
         * Hide the highlight overlay
         */
        hideHighlight() {
            if (this.highlightOverlay) {
                this.highlightOverlay.style.display = 'none';
            }
            this.currentElement = null;
        }

        /**
         * Update highlight position (useful for dynamic content)
         */
        updateHighlightPosition() {
            if (this.currentElement && this.highlightOverlay.style.display !== 'none') {
                const bounds = EnscribeUtils.getElementBounds(this.currentElement);
                this.highlightOverlay.style.left = `${bounds.left + window.scrollX}px`;
                this.highlightOverlay.style.top = `${bounds.top + window.scrollY}px`;
                this.highlightOverlay.style.width = `${bounds.width}px`;
                this.highlightOverlay.style.height = `${bounds.height}px`;
            }
        }

        /**
         * Get currently highlighted element
         * @returns {Element|null} Currently highlighted element
         */
        getCurrentElement() {
            return this.currentElement;
        }

        /**
         * Set up scroll listener to update highlight position
         */
        setupScrollListener() {
            this.handleScroll = EnscribeUtils.throttle(() => {
                this.updateHighlightPosition();
            }, 16);
            
            window.addEventListener('scroll', this.handleScroll, true);
            window.addEventListener('resize', this.handleScroll);
        }

        /**
         * Clean up resources
         */
        destroy() {
            // Remove scroll listeners
            if (this.handleScroll) {
                window.removeEventListener('scroll', this.handleScroll, true);
                window.removeEventListener('resize', this.handleScroll);
            }
            
            if (this.highlightOverlay) {
                this.highlightOverlay.remove();
                this.highlightOverlay = null;
            }
            this.currentElement = null;
        }
    }

    // ============================================================================
    // ELEMENT SELECTOR SYSTEM
    // ============================================================================

    /**
     * Manages element selection functionality
     */
    class ElementSelector {
        constructor(stateManager, highlighter) {
            this.stateManager = stateManager;
            this.highlighter = highlighter;
            this.isSelectionMode = false;
            this.selectedElement = null;
            this.excludeSelectors = [
                '#enscriber-floating-panel',
                '#enscriber-highlight-overlay',
                '[id^="enscriber-"]',
                '[class*="enscriber-"]'
            ];
            
            // Throttled mouse move handler
            this.handleMouseMove = EnscribeUtils.throttle(this.onMouseMove.bind(this), 16);
            
            // Bind event handlers
            this.handleClick = this.handleClick.bind(this);
            this.handleKeyDown = this.handleKeyDown.bind(this);
        }

        /**
         * Enable element selection mode
         */
        enableSelectionMode() {
            if (this.isSelectionMode) return;
            
            this.isSelectionMode = true;
            document.body.style.cursor = 'crosshair';
            
            // Add event listeners
            document.addEventListener('mousemove', this.handleMouseMove, true);
            document.addEventListener('click', this.handleClick, true);
            document.addEventListener('keydown', this.handleKeyDown, true);
            
            // Update state
            this.stateManager.setState({
                mode: ENSCRIBER_CONFIG.modes.MANUAL_SELECTION
            });
            
            console.log('Enscriber: Element selection mode enabled');
        }

        /**
         * Disable element selection mode
         */
        disableSelectionMode() {
            if (!this.isSelectionMode) return;
            
            this.isSelectionMode = false;
            document.body.style.cursor = '';
            
            // Remove event listeners
            document.removeEventListener('mousemove', this.handleMouseMove, true);
            document.removeEventListener('click', this.handleClick, true);
            document.removeEventListener('keydown', this.handleKeyDown, true);
            
            // Hide highlight
            this.highlighter.hideHighlight();
            
            console.log('Enscriber: Element selection mode disabled');
        }

        /**
         * Toggle selection mode
         */
        toggleSelectionMode() {
            if (this.isSelectionMode) {
                this.disableSelectionMode();
            } else {
                this.enableSelectionMode();
            }
        }

        /**
         * Handle mouse move events
         * @param {MouseEvent} event - Mouse event
         */
        onMouseMove(event) {
            if (!this.isSelectionMode) return;
            
            const element = this.getElementUnderCursor(event);
            if (element && !this.isExcludedElement(element)) {
                this.highlighter.highlightElement(element, 'hover');
            } else {
                this.highlighter.hideHighlight();
            }
        }

        /**
         * Handle click events
         * @param {MouseEvent} event - Click event
         */
        handleClick(event) {
            if (!this.isSelectionMode) return;
            
            event.preventDefault();
            event.stopPropagation();
            
            const element = this.getElementUnderCursor(event);
            if (element && !this.isExcludedElement(element)) {
                this.selectElement(element);
            }
        }

        /**
         * Handle keyboard events
         * @param {KeyboardEvent} event - Keyboard event
         */
        handleKeyDown(event) {
            if (!this.isSelectionMode) return;
            
            // Escape key to cancel selection
            if (event.key === 'Escape') {
                event.preventDefault();
                this.disableSelectionMode();
            }
        }

        /**
         * Select an element
         * @param {Element} element - Element to select
         * @param {string} actionType - Type of action to record
         */
        selectElement(element, actionType = 'click') {
            this.selectedElement = element;
            
            // Capture element metadata
            const metadata = this.captureElementMetadata(element);
            
            // Determine action type based on element
            let detectedActionType = actionType;
            if (actionType === 'click') {
                const tagName = element.tagName.toLowerCase();
                const inputType = element.type ? element.type.toLowerCase() : '';
                
                if (tagName === 'input') {
                    if (['text', 'email', 'password', 'search', 'tel', 'url'].includes(inputType)) {
                        detectedActionType = 'input';
                    } else if (['checkbox', 'radio'].includes(inputType)) {
                        detectedActionType = 'check';
                    }
                } else if (tagName === 'textarea') {
                    detectedActionType = 'input';
                } else if (tagName === 'select') {
                    detectedActionType = 'select';
                }
            }
            
            // Create action record
            const actionRecord = {
                id: this.generateActionId(),
                timestamp: Date.now(),
                type: detectedActionType,
                element: metadata,
                value: this.getElementValue(element, detectedActionType),
                notes: '',
                context: {
                    url: window.location.href,
                    title: document.title,
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight
                    }
                }
            };
            
            // Add to recorded actions
            const currentState = this.stateManager.getState();
            const currentSession = currentState.currentSession || { actions: [] };
            const updatedActions = [...currentSession.actions, actionRecord];
            
            // Update state with new action and selected element
            this.stateManager.setState({
                selectedElement: {
                    element: element,
                    metadata: metadata,
                    timestamp: Date.now()
                },
                currentSession: {
                    ...currentSession,
                    actions: updatedActions
                }
            });
            
            console.log('Enscriber: Element selected and action recorded:', element, actionRecord);
            
            // Show action confirmation
            this.showActionConfirmation(element, detectedActionType);
            
            // Continue recording - don't disable selection mode
            // User can press Escape or click Stop Recording to end the session
        }

        /**
         * Get element value based on action type
         * @param {Element} element - Target element
         * @param {string} actionType - Type of action
         * @returns {string} Element value
         */
        getElementValue(element, actionType) {
            switch (actionType) {
                case 'input':
                    return element.value || element.placeholder || '';
                case 'check':
                    return element.checked ? 'checked' : 'unchecked';
                case 'select':
                    return element.selectedOptions.length > 0 ? element.selectedOptions[0].text : '';
                default:
                    return element.textContent ? element.textContent.trim().substring(0, 50) : '';
            }
        }

        /**
         * Show action confirmation
         * @param {Element} element - Selected element
         * @param {string} actionType - Type of action recorded
         */
        showActionConfirmation(element, actionType) {
            // Show brief highlight for selected element
            this.highlighter.highlightElement(element, 'selected');
            
            // Create floating confirmation message
            const confirmation = document.createElement('div');
            confirmation.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: #22c55e;
                color: white;
                padding: 8px 16px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
                z-index: ${ENSCRIBER_CONFIG.ui.zIndex + 2};
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                animation: slideIn 0.3s ease-out;
            `;
            
            confirmation.textContent = `✓ ${actionType.toUpperCase()} action recorded`;
            document.body.appendChild(confirmation);
            
            // Add CSS animation
            if (!document.getElementById('enscriber-animations')) {
                const style = document.createElement('style');
                style.id = 'enscriber-animations';
                style.textContent = `
                    @keyframes slideIn {
                        from { transform: translateX(100%); opacity: 0; }
                        to { transform: translateX(0); opacity: 1; }
                    }
                `;
                document.head.appendChild(style);
            }
            
            // Remove confirmation after delay
            setTimeout(() => {
                if (confirmation.parentNode) {
                    confirmation.remove();
                }
                if (this.isSelectionMode) {
                    this.highlighter.hideHighlight();
                }
            }, 2000);
        }

        /**
         * Generate unique action ID
         * @returns {string} Unique action ID
         */
        generateActionId() {
            return `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        /**
         * Get element under cursor
         * @param {MouseEvent} event - Mouse event
         * @returns {Element|null} Element under cursor
         */
        getElementUnderCursor(event) {
            // Temporarily hide highlight overlay to get element underneath
            const overlay = this.highlighter.highlightOverlay;
            const originalDisplay = overlay ? overlay.style.display : '';
            if (overlay) overlay.style.display = 'none';
            
            const element = document.elementFromPoint(event.clientX, event.clientY);
            
            // Restore overlay
            if (overlay) overlay.style.display = originalDisplay;
            
            return element;
        }

        /**
         * Check if element should be excluded from selection
         * @param {Element} element - Element to check
         * @returns {boolean} Whether element is excluded
         */
        isExcludedElement(element) {
            if (!element) return true;
            
            // Check if element is part of Enscriber UI (including Shadow DOM)
            let currentElement = element;
            while (currentElement) {
                // Check if element has Enscriber-related IDs or classes
                if (currentElement.id && currentElement.id.includes('enscriber')) {
                    return true;
                }
                if (currentElement.className && typeof currentElement.className === 'string' &&
                    currentElement.className.includes('enscriber')) {
                    return true;
                }
                
                // Check if we're inside the Enscriber floating panel
                if (currentElement.id === 'enscriber-floating-panel') {
                    return true;
                }
                
                // Check if we're in a shadow root that belongs to Enscriber
                if (currentElement.getRootNode && currentElement.getRootNode() !== document) {
                    const root = currentElement.getRootNode();
                    if (root.host && root.host.id === 'enscriber-floating-panel') {
                        return true;
                    }
                }
                
                currentElement = currentElement.parentElement || currentElement.parentNode;
            }
            
            // Check against exclude selectors as fallback
            for (const selector of this.excludeSelectors) {
                try {
                    if (element.matches && element.matches(selector)) {
                        return true;
                    }
                    if (element.closest && element.closest(selector)) {
                        return true;
                    }
                } catch (e) {
                    // Invalid selector, skip
                }
            }
            
            return false;
        }

        /**
         * Capture element metadata
         * @param {Element} element - Element to capture metadata for
         * @returns {Object} Element metadata
         */
        captureElementMetadata(element) {
            const bounds = EnscribeUtils.getElementBounds(element);
            const computedStyle = window.getComputedStyle(element);
            
            return {
                tagName: element.tagName.toLowerCase(),
                id: element.id || null,
                className: element.className || null,
                textContent: element.textContent ? element.textContent.trim().substring(0, 100) : null,
                attributes: this.getElementAttributes(element),
                position: {
                    x: bounds.left,
                    y: bounds.top,
                    width: bounds.width,
                    height: bounds.height
                },
                isVisible: EnscribeUtils.isElementVisible(element),
                computedStyles: {
                    display: computedStyle.display,
                    visibility: computedStyle.visibility,
                    opacity: computedStyle.opacity,
                    zIndex: computedStyle.zIndex
                },
                parentContext: this.getParentContext(element),
                xpath: this.generateXPath(element)
            };
        }

        /**
         * Get element attributes
         * @param {Element} element - Element to get attributes for
         * @returns {Object} Element attributes
         */
        getElementAttributes(element) {
            const attributes = {};
            for (const attr of element.attributes) {
                attributes[attr.name] = attr.value;
            }
            return attributes;
        }

        /**
         * Get parent context information
         * @param {Element} element - Element to get parent context for
         * @returns {Object} Parent context information
         */
        getParentContext(element) {
            const parent = element.parentElement;
            if (!parent) return null;
            
            return {
                tagName: parent.tagName.toLowerCase(),
                id: parent.id || null,
                className: parent.className || null,
                childIndex: Array.from(parent.children).indexOf(element)
            };
        }

        /**
         * Generate XPath for element
         * @param {Element} element - Element to generate XPath for
         * @returns {string} XPath string
         */
        generateXPath(element) {
            if (!element) return '';
            
            if (element.id) {
                return `//*[@id="${element.id}"]`;
            }
            
            const parts = [];
            let current = element;
            
            while (current && current.nodeType === Node.ELEMENT_NODE) {
                let index = 1;
                let sibling = current.previousElementSibling;
                
                while (sibling) {
                    if (sibling.tagName === current.tagName) {
                        index++;
                    }
                    sibling = sibling.previousElementSibling;
                }
                
                const tagName = current.tagName.toLowerCase();
                const part = index > 1 ? `${tagName}[${index}]` : tagName;
                parts.unshift(part);
                
                current = current.parentElement;
            }
            
            return '/' + parts.join('/');
        }

        /**
         * Get currently selected element
         * @returns {Element|null} Currently selected element
         */
        getSelectedElement() {
            return this.selectedElement;
        }

        /**
         * Clear selection
         */
        clearSelection() {
            this.selectedElement = null;
            this.highlighter.hideHighlight();
            
            this.stateManager.setState({
                selectedElement: null
            });
        }

        /**
         * Clean up resources
         */
        destroy() {
            this.disableSelectionMode();
            this.clearSelection();
        }
    }

    // ============================================================================
    // RECORDING ENGINE
    // ============================================================================

    /**
     * Manages recording modes and basic recording functionality
     */
    class RecordingEngine {
        constructor(stateManager, elementSelector, highlighter) {
            this.stateManager = stateManager;
            this.elementSelector = elementSelector;
            this.highlighter = highlighter;
            this.networkMonitor = new NetworkRequestMonitor(stateManager);
            this.recordingMode = ENSCRIBER_CONFIG.modes.INACTIVE;
            this.isRecording = false;
            this.recordedActions = [];
            
            // Set up state listeners
            this.setupStateListeners();
        }

        /**
         * Set up state change listeners
         */
        setupStateListeners() {
            this.stateManager.addListener('recording', (newState, prevState) => {
                if (newState.mode !== prevState.mode) {
                    this.handleModeChange(newState.mode, prevState.mode);
                }
            });
        }

        /**
         * Handle recording mode changes
         * @param {string} newMode - New recording mode
         * @param {string} prevMode - Previous recording mode
         */
        handleModeChange(newMode, prevMode) {
            console.log(`Enscriber: Recording mode changed from ${prevMode} to ${newMode}`);
            
            this.recordingMode = newMode;
            
            switch (newMode) {
                case ENSCRIBER_CONFIG.modes.MANUAL_SELECTION:
                    this.startManualSelection();
                    break;
                case ENSCRIBER_CONFIG.modes.AUTO_RECORDING:
                    this.startAutoRecording();
                    break;
                case ENSCRIBER_CONFIG.modes.PAUSED:
                    this.pauseRecording();
                    break;
                case ENSCRIBER_CONFIG.modes.INACTIVE:
                    this.stopRecording();
                    break;
            }
        }

        /**
         * Start manual selection mode
         */
        startManualSelection() {
            this.initializeSession();
            this.elementSelector.enableSelectionMode();
            this.networkMonitor.startMonitoring();
            this.isRecording = true;
        }

        /**
         * Start auto recording mode
         */
        startAutoRecording() {
            this.initializeSession();
            // For now, just enable selection mode
            // Full auto recording will be implemented in future phases
            this.elementSelector.enableSelectionMode();
            this.networkMonitor.startMonitoring();
            this.isRecording = true;
        }

        /**
         * Pause recording
         */
        pauseRecording() {
            this.elementSelector.disableSelectionMode();
            this.networkMonitor.stopMonitoring();
            // Keep isRecording true but disable interactions
        }

        /**
         * Stop recording
         */
        stopRecording() {
            this.elementSelector.disableSelectionMode();
            this.networkMonitor.stopMonitoring();
            this.isRecording = false;
            
            // Save current session if it exists, but keep it in state for persistence
            const currentState = this.stateManager.getState();
            if (currentState.currentSession) {
                const sessionData = {
                    ...currentState.currentSession,
                    endTime: Date.now()
                };
                
                // Save session to storage
                try {
                    const key = `${ENSCRIBER_CONFIG.storage.prefix}session_${sessionData.id}`;
                    GM_setValue(key, JSON.stringify(sessionData));
                    console.log(`Enscriber: Session ${sessionData.id} saved with ${sessionData.actions.length} actions`);
                } catch (error) {
                    console.error('Enscriber: Failed to save session:', error);
                }
                
                // Keep the session in state so actions persist until manually cleared
                this.stateManager.setState({
                    currentSession: sessionData
                });
            }
        }

        /**
         * Toggle recording mode between inactive and manual selection
         */
        toggleRecording() {
            const currentState = this.stateManager.getState();
            
            if (currentState.mode === ENSCRIBER_CONFIG.modes.INACTIVE) {
                // Start recording
                this.stateManager.setState({
                    mode: ENSCRIBER_CONFIG.modes.MANUAL_SELECTION,
                    isRecording: true
                });
            } else {
                // Stop recording
                this.stateManager.setState({
                    mode: ENSCRIBER_CONFIG.modes.INACTIVE,
                    isRecording: false
                });
            }
        }

        /**
         * Get current recording mode
         * @returns {string} Current recording mode
         */
        getRecordingMode() {
            return this.recordingMode;
        }

        /**
         * Check if currently recording
         * @returns {boolean} Whether currently recording
         */
        isCurrentlyRecording() {
            return this.isRecording;
        }

        /**
         * Get recorded actions
         * @returns {Array} Array of recorded actions
         */
        getRecordedActions() {
            return [...this.recordedActions];
        }

        /**
         * Clear recorded actions
         */
        clearRecordedActions() {
            this.recordedActions = [];
        }

        /**
         * Initialize a new recording session
         */
        initializeSession() {
            const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const sessionData = {
                id: sessionId,
                name: `Session ${new Date().toLocaleString()}`,
                url: window.location.href,
                startTime: Date.now(),
                actions: [],
                settings: { ...this.stateManager.getState().settings },
                metadata: {
                    userAgent: navigator.userAgent,
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight
                    }
                }
            };

            this.stateManager.setState({
                currentSession: sessionData
            });

            console.log(`Enscriber: Initialized session ${sessionId}`);
        }

        /**
         * Clean up resources
         */
        destroy() {
            this.stopRecording();
            if (this.networkMonitor) {
                this.networkMonitor.destroy();
            }
            this.recordedActions = [];
        }
    }

    // ============================================================================
    // NETWORK REQUEST MONITORING
    // ============================================================================

    /**
     * Monitors network requests and provides selective addition to action list
     */
    class NetworkRequestMonitor {
        constructor(stateManager) {
            this.stateManager = stateManager;
            this.isMonitoring = false;
            this.capturedRequests = [];
            this.originalFetch = null;
            this.originalXHROpen = null;
            this.originalXHRSend = null;
            
            // Request filtering options
            this.filters = {
                methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                excludePatterns: [
                    /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)$/i,
                    /google-analytics/i,
                    /googletagmanager/i,
                    /facebook\.net/i,
                    /doubleclick\.net/i
                ]
            };
        }

        /**
         * Start monitoring network requests
         */
        startMonitoring() {
            if (this.isMonitoring) return;
            
            this.isMonitoring = true;
            this.capturedRequests = [];
            
            // Intercept fetch API
            this.interceptFetch();
            
            // Intercept XMLHttpRequest
            this.interceptXHR();
            
            console.log('Enscriber: Network request monitoring started');
        }

        /**
         * Stop monitoring network requests
         */
        stopMonitoring() {
            if (!this.isMonitoring) return;
            
            this.isMonitoring = false;
            
            // Restore original fetch
            if (this.originalFetch) {
                window.fetch = this.originalFetch;
                this.originalFetch = null;
            }
            
            // Restore original XMLHttpRequest
            if (this.originalXHROpen && this.originalXHRSend) {
                XMLHttpRequest.prototype.open = this.originalXHROpen;
                XMLHttpRequest.prototype.send = this.originalXHRSend;
                this.originalXHROpen = null;
                this.originalXHRSend = null;
            }
            
            console.log('Enscriber: Network request monitoring stopped');
        }

        /**
         * Intercept fetch API calls
         */
        interceptFetch() {
            this.originalFetch = window.fetch;
            const self = this;
            
            window.fetch = function(input, init = {}) {
                const url = typeof input === 'string' ? input : input.url;
                const method = init.method || 'GET';
                const headers = init.headers || {};
                const body = init.body;
                
                const requestData = {
                    id: EnscribeUtils.generateId(),
                    timestamp: Date.now(),
                    method: method.toUpperCase(),
                    url: url,
                    headers: self.normalizeHeaders(headers),
                    body: self.serializeBody(body),
                    type: 'fetch'
                };
                
                // Call original fetch and capture response
                const fetchPromise = self.originalFetch.call(this, input, init);
                
                fetchPromise.then(response => {
                    requestData.status = response.status;
                    requestData.statusText = response.statusText;
                    requestData.responseHeaders = self.extractResponseHeaders(response);
                    
                    if (self.shouldCaptureRequest(requestData)) {
                        self.capturedRequests.push(requestData);
                        self.notifyRequestCaptured(requestData);
                    }
                }).catch(error => {
                    requestData.error = error.message;
                    
                    if (self.shouldCaptureRequest(requestData)) {
                        self.capturedRequests.push(requestData);
                        self.notifyRequestCaptured(requestData);
                    }
                });
                
                return fetchPromise;
            };
        }

        /**
         * Intercept XMLHttpRequest calls
         */
        interceptXHR() {
            this.originalXHROpen = XMLHttpRequest.prototype.open;
            this.originalXHRSend = XMLHttpRequest.prototype.send;
            const self = this;
            
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                this._enscriber_method = method.toUpperCase();
                this._enscriber_url = url;
                this._enscriber_timestamp = Date.now();
                
                return self.originalXHROpen.call(this, method, url, async, user, password);
            };
            
            XMLHttpRequest.prototype.send = function(body) {
                const xhr = this;
                const requestData = {
                    id: EnscribeUtils.generateId(),
                    timestamp: xhr._enscriber_timestamp || Date.now(),
                    method: xhr._enscriber_method || 'GET',
                    url: xhr._enscriber_url || '',
                    headers: {},
                    body: self.serializeBody(body),
                    type: 'xhr'
                };
                
                // Capture request headers (limited access)
                try {
                    if (xhr.getAllResponseHeaders) {
                        // We can't get request headers easily, but we'll capture what we can
                        requestData.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
                    }
                } catch (e) {
                    // Ignore header access errors
                }
                
                // Set up response handler
                const originalOnReadyStateChange = xhr.onreadystatechange;
                xhr.onreadystatechange = function() {
                    if (xhr.readyState === 4) {
                        requestData.status = xhr.status;
                        requestData.statusText = xhr.statusText;
                        
                        try {
                            const responseHeaders = xhr.getAllResponseHeaders();
                            requestData.responseHeaders = self.parseResponseHeaders(responseHeaders);
                        } catch (e) {
                            requestData.responseHeaders = {};
                        }
                        
                        if (self.shouldCaptureRequest(requestData)) {
                            self.capturedRequests.push(requestData);
                            self.notifyRequestCaptured(requestData);
                        }
                    }
                    
                    if (originalOnReadyStateChange) {
                        originalOnReadyStateChange.call(this);
                    }
                };
                
                return self.originalXHRSend.call(this, body);
            };
        }

        /**
         * Normalize headers to a consistent format
         */
        normalizeHeaders(headers) {
            const normalized = {};
            
            if (headers instanceof Headers) {
                for (const [key, value] of headers.entries()) {
                    normalized[key] = value;
                }
            } else if (typeof headers === 'object' && headers !== null) {
                Object.assign(normalized, headers);
            }
            
            return normalized;
        }

        /**
         * Extract response headers from fetch Response
         */
        extractResponseHeaders(response) {
            const headers = {};
            
            try {
                for (const [key, value] of response.headers.entries()) {
                    headers[key] = value;
                }
            } catch (e) {
                // Ignore header access errors
            }
            
            return headers;
        }

        /**
         * Parse response headers from XHR string format
         */
        parseResponseHeaders(headerString) {
            const headers = {};
            
            if (headerString) {
                headerString.split('\r\n').forEach(line => {
                    const parts = line.split(': ');
                    if (parts.length === 2) {
                        headers[parts[0]] = parts[1];
                    }
                });
            }
            
            return headers;
        }

        /**
         * Serialize request body for storage
         */
        serializeBody(body) {
            if (!body) return null;
            
            if (typeof body === 'string') {
                return body;
            }
            
            if (body instanceof FormData) {
                const formObject = {};
                for (const [key, value] of body.entries()) {
                    formObject[key] = value;
                }
                return JSON.stringify(formObject);
            }
            
            if (body instanceof URLSearchParams) {
                return body.toString();
            }
            
            try {
                return JSON.stringify(body);
            } catch (e) {
                return '[Unserializable Body]';
            }
        }

        /**
         * Check if request should be captured based on filters
         */
        shouldCaptureRequest(requestData) {
            // Check method filter
            if (!this.filters.methods.includes(requestData.method)) {
                return false;
            }
            
            // Check exclude patterns
            for (const pattern of this.filters.excludePatterns) {
                if (pattern.test(requestData.url)) {
                    return false;
                }
            }
            
            // Don't capture requests to the same origin that are likely internal
            try {
                const url = new URL(requestData.url, window.location.href);
                if (url.pathname.includes('enscriber')) {
                    return false;
                }
            } catch (e) {
                // Invalid URL, skip
                return false;
            }
            
            return true;
        }

        /**
         * Notify that a request was captured
         */
        notifyRequestCaptured(requestData) {
            // Update state to trigger UI refresh
            const currentState = this.stateManager.getState();
            this.stateManager.setState({
                networkRequests: [...(currentState.networkRequests || []), requestData]
            });
        }

        /**
         * Get all captured requests
         */
        getCapturedRequests() {
            return [...this.capturedRequests];
        }

        /**
         * Clear captured requests
         */
        clearCapturedRequests() {
            this.capturedRequests = [];
            this.stateManager.setState({
                networkRequests: []
            });
        }

        /**
         * Add a network request to the action list
         */
        addRequestToActions(requestData, actionType = 'waitForResponse') {
            const currentState = this.stateManager.getState();
            const currentSession = currentState.currentSession || { actions: [] };
            
            const actionRecord = {
                id: EnscribeUtils.generateId(),
                timestamp: Date.now(),
                type: actionType,
                networkRequest: requestData,
                notes: `${requestData.method} ${requestData.url}`,
                context: {
                    url: window.location.href,
                    title: document.title,
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight
                    }
                }
            };
            
            const updatedActions = [...currentSession.actions, actionRecord];
            
            this.stateManager.setState({
                currentSession: {
                    ...currentSession,
                    actions: updatedActions
                }
            });
            
            console.log('Enscriber: Network request added to actions:', requestData);
        }

        /**
         * Clean up resources
         */
        destroy() {
            this.stopMonitoring();
            this.capturedRequests = [];
        }
    }

    // ============================================================================
    // CORE ENGINE
    // ============================================================================

    /**
     * Main application controller and orchestrator
     */
    class EnscribeCore {
        constructor() {
            this.version = ENSCRIBER_CONFIG.version;
            this.isInitialized = false;
            this.stateManager = new StateManager();
            this.uiManager = null;
            this.elementHighlighter = null;
            this.elementSelector = null;
            this.recordingEngine = null;
            this.eventListeners = new Map();
            
            // Bind methods to preserve context
            this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
            this.handleBeforeUnload = this.handleBeforeUnload.bind(this);
        }

        /**
         * Initialize the Enscriber application
         * @param {Object} [config] - Optional configuration overrides
         * @returns {Promise<void>}
         */
        async initialize(config = {}) {
            if (this.isInitialized) {
                console.warn('Enscriber: Already initialized');
                return;
            }

            try {
                console.log(`Enscriber v${this.version} initializing...`);

                // Merge configuration
                Object.assign(ENSCRIBER_CONFIG, config);

                // Initialize UI Manager
                this.uiManager = new UIManager(this.stateManager);
                await this.uiManager.initialize();

                // Initialize element highlighting and selection system
                this.elementHighlighter = new ElementHighlighter();
                this.elementSelector = new ElementSelector(this.stateManager, this.elementHighlighter);
                this.recordingEngine = new RecordingEngine(this.stateManager, this.elementSelector, this.elementHighlighter);

                // Connect UI Manager with selection system
                this.uiManager.setRecordingEngine(this.recordingEngine);

                // Set up global event listeners
                this.setupGlobalEventListeners();

                // Initialize state
                this.stateManager.setState({
                    mode: ENSCRIBER_CONFIG.modes.INACTIVE,
                    isRecording: false,
                    selectedElement: null
                });

                this.isInitialized = true;
                console.log('Enscriber: Initialization complete');

                // Emit initialization event
                this.emit('initialized', { version: this.version });

            } catch (error) {
                console.error('Enscriber: Initialization failed:', error);
                throw error;
            }
        }

        /**
         * Set recording mode
         * @param {string} mode - Recording mode
         */
        setRecordingMode(mode) {
            if (!Object.values(ENSCRIBER_CONFIG.modes).includes(mode)) {
                throw new Error(`Invalid recording mode: ${mode}`);
            }

            const previousMode = this.stateManager.getState().mode;
            this.stateManager.setState({ mode });

            console.log(`Enscriber: Mode changed from ${previousMode} to ${mode}`);
            this.emit('modeChanged', { previousMode, newMode: mode });
        }

        /**
         * Get current recording mode
         * @returns {string} Current mode
         */
        getRecordingMode() {
            return this.stateManager.getState().mode;
        }

        /**
         * Start a new recording session
         * @param {string} [name] - Session name
         * @param {string} [url] - Session URL
         * @returns {string} Session ID
         */
        startSession(name = null, url = null) {
            const sessionId = EnscribeUtils.generateId();
            const sessionData = {
                id: sessionId,
                name: name || `Session ${new Date().toLocaleString()}`,
                url: url || window.location.href,
                startTime: Date.now(),
                actions: [],
                settings: { ...this.stateManager.getState().settings },
                metadata: {
                    userAgent: navigator.userAgent,
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight
                    }
                }
            };

            this.stateManager.setState({
                currentSession: sessionData,
                isRecording: true,
                mode: ENSCRIBER_CONFIG.modes.AUTO_RECORDING
            });

            console.log(`Enscriber: Started session ${sessionId}`);
            this.emit('sessionStarted', { sessionId, sessionData });

            return sessionId;
        }

        /**
         * Stop the current recording session
         */
        stopSession() {
            const state = this.stateManager.getState();
            if (!state.currentSession) {
                console.warn('Enscriber: No active session to stop');
                return;
            }

            const sessionData = {
                ...state.currentSession,
                endTime: Date.now()
            };

            // Save session data
            this.saveSession(sessionData);

            this.stateManager.setState({
                currentSession: null,
                isRecording: false,
                mode: ENSCRIBER_CONFIG.modes.INACTIVE
            });

            console.log(`Enscriber: Stopped session ${sessionData.id}`);
            this.emit('sessionStopped', { sessionData });
        }

        /**
         * Pause the current recording session
         */
        pauseSession() {
            const state = this.stateManager.getState();
            if (!state.isRecording) {
                console.warn('Enscriber: No active session to pause');
                return;
            }

            this.stateManager.setState({
                isPaused: true,
                mode: ENSCRIBER_CONFIG.modes.PAUSED
            });

            console.log('Enscriber: Session paused');
            this.emit('sessionPaused');
        }

        /**
         * Resume the current recording session
         */
        resumeSession() {
            const state = this.stateManager.getState();
            if (!state.isPaused) {
                console.warn('Enscriber: No paused session to resume');
                return;
            }

            this.stateManager.setState({
                isPaused: false,
                mode: ENSCRIBER_CONFIG.modes.AUTO_RECORDING
            });

            console.log('Enscriber: Session resumed');
            this.emit('sessionResumed');
        }

        /**
         * Save session data to storage
         * @param {SessionData} sessionData - Session data to save
         */
        saveSession(sessionData) {
            try {
                const key = `${ENSCRIBER_CONFIG.storage.prefix}session_${sessionData.id}`;
                GM_setValue(key, JSON.stringify(sessionData));
                console.log(`Enscriber: Session ${sessionData.id} saved`);
            } catch (error) {
                console.error('Enscriber: Failed to save session:', error);
            }
        }

        /**
         * Add event listener
         * @param {string} type - Event type
         * @param {Function} handler - Event handler
         */
        addEventListener(type, handler) {
            if (!this.eventListeners.has(type)) {
                this.eventListeners.set(type, []);
            }
            this.eventListeners.get(type).push(handler);
        }

        /**
         * Remove event listener
         * @param {string} type - Event type
         * @param {Function} handler - Event handler
         */
        removeEventListener(type, handler) {
            if (this.eventListeners.has(type)) {
                const handlers = this.eventListeners.get(type);
                const index = handlers.indexOf(handler);
                if (index > -1) {
                    handlers.splice(index, 1);
                }
            }
        }

        /**
         * Emit event to listeners
         * @param {string} type - Event type
         * @param {*} data - Event data
         */
        emit(type, data) {
            if (this.eventListeners.has(type)) {
                this.eventListeners.get(type).forEach(handler => {
                    try {
                        handler(data);
                    } catch (error) {
                        console.error(`Enscriber: Error in event handler for ${type}:`, error);
                    }
                });
            }
        }

        /**
         * Set up global event listeners
         */
        setupGlobalEventListeners() {
            // Handle page visibility changes
            document.addEventListener('visibilitychange', this.handleVisibilityChange);
            
            // Handle page unload
            window.addEventListener('beforeunload', this.handleBeforeUnload);
            
            // Handle keyboard shortcuts
            document.addEventListener('keydown', this.handleKeyboardShortcuts.bind(this));
        }

        /**
         * Handle page visibility changes
         */
        handleVisibilityChange() {
            if (document.hidden) {
                // Page is hidden, pause recording if active
                const state = this.stateManager.getState();
                if (state.isRecording && !state.isPaused) {
                    this.pauseSession();
                }
            }
        }

        /**
         * Handle page unload
         */
        handleBeforeUnload() {
            // Save current session if active
            const state = this.stateManager.getState();
            if (state.currentSession) {
                this.saveSession({
                    ...state.currentSession,
                    endTime: Date.now()
                });
            }
        }

        /**
         * Handle keyboard shortcuts
         * @param {KeyboardEvent} event - Keyboard event
         */
        handleKeyboardShortcuts(event) {
            // Ctrl+Shift+E: Toggle Enscriber panel
            if (event.ctrlKey && event.shiftKey && event.key === 'E') {
                event.preventDefault();
                if (this.uiManager) {
                    this.uiManager.togglePanel();
                }
            }
        }

        /**
         * Clean up resources
         */
        destroy() {
            // Remove global event listeners
            document.removeEventListener('visibilitychange', this.handleVisibilityChange);
            window.removeEventListener('beforeunload', this.handleBeforeUnload);
            
            // Stop current session
            const state = this.stateManager.getState();
            if (state.currentSession) {
                this.stopSession();
            }
            
            // Destroy selection and highlighting system
            if (this.recordingEngine) {
                this.recordingEngine.destroy();
            }
            if (this.elementSelector) {
                this.elementSelector.destroy();
            }
            if (this.elementHighlighter) {
                this.elementHighlighter.destroy();
            }
            
            // Destroy UI
            if (this.uiManager) {
                this.uiManager.destroy();
            }
            
            // Clear event listeners
            this.eventListeners.clear();
            
            this.isInitialized = false;
            console.log('Enscriber: Destroyed');
        }
    }

    // ============================================================================
    // UI MANAGER
    // ============================================================================

    /**
     * Manages the floating panel UI and user interactions
     */
    class UIManager {
        constructor(stateManager) {
            this.stateManager = stateManager;
            this.recordingEngine = null;
            this.shadowRoot = null;
            this.panelElement = null;
            this.isDragging = false;
            this.isResizing = false;
            this.dragOffset = { x: 0, y: 0 };
            this.resizeHandle = null;
            
            // Bind methods
            this.handleMouseDown = this.handleMouseDown.bind(this);
            this.handleMouseMove = this.handleMouseMove.bind(this);
            this.handleMouseUp = this.handleMouseUp.bind(this);
            this.handleResize = this.handleResize.bind(this);
        }

        /**
         * Set the recording engine reference
         * @param {RecordingEngine} recordingEngine - Recording engine instance
         */
        setRecordingEngine(recordingEngine) {
            this.recordingEngine = recordingEngine;
        }

        /**
         * Initialize the UI Manager
         */
        async initialize() {
            try {
                await this.createFloatingPanel();
                this.setupEventListeners();
                this.setupStateListeners();
                console.log('Enscriber UI: Initialized');
            } catch (error) {
                console.error('Enscriber UI: Initialization failed:', error);
                throw error;
            }
        }

        /**
         * Create the floating panel with Shadow DOM isolation
         */
        async createFloatingPanel() {
            // Create container element
            const container = document.createElement('div');
            container.id = ENSCRIBER_CONFIG.ui.panelId;
            container.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                z-index: ${ENSCRIBER_CONFIG.ui.zIndex};
                pointer-events: none;
            `;

            // Create shadow root for CSS isolation
            this.shadowRoot = container.attachShadow({ mode: 'closed' });

            // Inject CSS styles
            this.injectStyles();

            // Create panel structure
            this.createPanelStructure();

            // Append to document
            document.body.appendChild(container);

            // Set initial position and size
            this.updatePanelTransform();
        }

        /**
         * Inject CSS styles into shadow DOM
         */
        injectStyles() {
            const style = document.createElement('style');
            style.textContent = `
                /* Reset and base styles */
                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                }

                /* Main panel container */
                .enscriber-panel {
                    width: ${ENSCRIBER_CONFIG.ui.defaultWidth}px;
                    height: ${ENSCRIBER_CONFIG.ui.defaultHeight}px;
                    background: #ffffff;
                    border: 1px solid #e1e5e9;
                    border-radius: 8px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 14px;
                    line-height: 1.4;
                    color: #2d3748;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    pointer-events: auto;
                    transition: opacity 0.2s ease, transform 0.2s ease;
                }

                .enscriber-panel.collapsed {
                    width: 48px;
                    height: 48px;
                    border-radius: 24px;
                }

                .enscriber-panel.dragging {
                    user-select: none;
                    cursor: grabbing;
                }

                /* Header */
                .enscriber-header {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 12px 16px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    cursor: grab;
                    user-select: none;
                    min-height: 48px;
                }

                .enscriber-header:active {
                    cursor: grabbing;
                }

                .enscriber-title {
                    font-weight: 600;
                    font-size: 16px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .enscriber-logo {
                    width: 20px;
                    height: 20px;
                    background: rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 12px;
                    font-weight: bold;
                }

                .enscriber-controls {
                    display: flex;
                    gap: 8px;
                }

                .enscriber-btn {
                    background: rgba(255, 255, 255, 0.2);
                    border: none;
                    color: white;
                    width: 24px;
                    height: 24px;
                    border-radius: 4px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 12px;
                    transition: background-color 0.2s ease;
                }

                .enscriber-btn:hover {
                    background: rgba(255, 255, 255, 0.3);
                }

                /* Content area */
                .enscriber-content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }

                .enscriber-section {
                    border-bottom: 1px solid #e2e8f0;
                }

                .enscriber-section:last-child {
                    border-bottom: none;
                }

                .enscriber-section-header {
                    background: linear-gradient(90deg, #f0f9f4 0%, #ecfdf5 100%);
                    padding: 8px 16px;
                    font-weight: 500;
                    font-size: 12px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: #2d5016;
                    cursor: pointer;
                    user-select: none;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    border-left: 3px solid #4a7c59;
                }

                .enscriber-section-header:hover {
                    background: linear-gradient(90deg, #ecfdf5 0%, #d1fae5 100%);
                }

                .enscriber-section-content {
                    padding: 16px;
                    max-height: 200px;
                    overflow-y: auto;
                }

                .enscriber-section.collapsed .enscriber-section-content {
                    display: none;
                }

                /* Status section */
                .enscriber-status {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .enscriber-status-indicator {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #e2e8f0;
                }

                .enscriber-status-indicator.recording {
                    background: linear-gradient(45deg, #dc2626, #ef4444);
                    animation: pulse 2s infinite;
                }

                .enscriber-status-indicator.paused {
                    background: linear-gradient(45deg, #d97706, #f59e0b);
                }

                .enscriber-status-indicator.inactive {
                    background: linear-gradient(45deg, #2d5016, #4a7c59);
                }

                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }

                /* Action list */
                .enscriber-action-list {
                    list-style: none;
                }

                .enscriber-action-item {
                    padding: 8px 0;
                    border-bottom: 1px solid #f1f5f9;
                    font-size: 12px;
                }

                .enscriber-action-item:last-child {
                    border-bottom: none;
                }

                .enscriber-action-type {
                    font-weight: 500;
                    color: #2d5016;
                }

                .enscriber-action-element {
                    color: #718096;
                    margin-top: 2px;
                }

                /* Notes section */
                .enscriber-notes-textarea {
                    width: 100%;
                    min-height: 80px;
                    border: 1px solid #e2e8f0;
                    border-radius: 4px;
                    padding: 8px;
                    font-size: 12px;
                    font-family: inherit;
                    resize: vertical;
                }

                .enscriber-notes-textarea:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                }

                /* Footer */
                .enscriber-footer {
                    padding: 12px 16px;
                    background: #f7fafc;
                    border-top: 1px solid #e2e8f0;
                    display: flex;
                    gap: 8px;
                    justify-content: space-between;
                    align-items: center;
                }

                .enscriber-footer-left {
                    display: flex;
                    gap: 8px;
                }

                .enscriber-footer-right {
                    display: flex;
                    gap: 8px;
                }

                .enscriber-btn-primary {
                    background: #667eea;
                    color: white;
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                }

                .enscriber-btn-primary:hover {
                    background: #5a67d8;
                }

                .enscriber-btn-secondary {
                    background: #e2e8f0;
                    color: #4a5568;
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                }

                .enscriber-btn-secondary:hover {
                    background: #cbd5e0;
                }

                /* Resize handles */
                .enscriber-resize-handle {
                    position: absolute;
                    background: transparent;
                }

                .enscriber-resize-handle.corner {
                    width: 12px;
                    height: 12px;
                }

                .enscriber-resize-handle.edge {
                    background: transparent;
                }

                .enscriber-resize-handle.top {
                    top: 0;
                    left: 12px;
                    right: 12px;
                    height: 4px;
                    cursor: n-resize;
                }

                .enscriber-resize-handle.bottom {
                    bottom: 0;
                    left: 12px;
                    right: 12px;
                    height: 4px;
                    cursor: s-resize;
                }

                .enscriber-resize-handle.left {
                    left: 0;
                    top: 12px;
                    bottom: 12px;
                    width: 4px;
                    cursor: w-resize;
                }

                .enscriber-resize-handle.right {
                    right: 0;
                    top: 12px;
                    bottom: 12px;
                    width: 4px;
                    cursor: e-resize;
                }

                .enscriber-resize-handle.top-left {
                    top: 0;
                    left: 0;
                    cursor: nw-resize;
                }

                .enscriber-resize-handle.top-right {
                    top: 0;
                    right: 0;
                    cursor: ne-resize;
                }

                .enscriber-resize-handle.bottom-left {
                    bottom: 0;
                    left: 0;
                    cursor: sw-resize;
                }

                .enscriber-resize-handle.bottom-right {
                    bottom: 0;
                    right: 0;
                    cursor: se-resize;
                }

                /* Collapsed state */
                .enscriber-panel.collapsed .enscriber-content,
                .enscriber-panel.collapsed .enscriber-footer {
                    display: none;
                }

                .enscriber-panel.collapsed .enscriber-header {
                    padding: 12px;
                    border-radius: 24px;
                }

                .enscriber-panel.collapsed .enscriber-title {
                    display: none;
                }

                .enscriber-panel.collapsed .enscriber-controls {
                    display: none;
                }

                /* Utility classes */
                .enscriber-hidden {
                    display: none !important;
                }

                .enscriber-text-muted {
                    color: #718096;
                }

                .enscriber-text-small {
                    font-size: 11px;
                }

                /* Scrollbar styling */
                .enscriber-section-content::-webkit-scrollbar {
                    width: 8px;
                }

                .enscriber-section-content::-webkit-scrollbar-track {
                    background: #f1f5f9;
                    border-radius: 4px;
                }

                .enscriber-section-content::-webkit-scrollbar-thumb {
                    background: #cbd5e0;
                    border-radius: 4px;
                    border: 1px solid #e2e8f0;
                }

                .enscriber-section-content::-webkit-scrollbar-thumb:hover {
                    background: #a0aec0;
                }

                .enscriber-section-content::-webkit-scrollbar-corner {
                    background: #f1f5f9;
                }
            `;
            
            this.shadowRoot.appendChild(style);
        }

        /**
         * Create the panel structure
         */
        createPanelStructure() {
            const panel = document.createElement('div');
            panel.className = 'enscriber-panel';
            
            // Header
            const header = this.createHeader();
            panel.appendChild(header);
            
            // Content
            const content = this.createContent();
            panel.appendChild(content);
            
            // Footer
            const footer = this.createFooter();
            panel.appendChild(footer);
            
            // Resize handles
            this.createResizeHandles(panel);
            
            this.panelElement = panel;
            this.shadowRoot.appendChild(panel);
        }

        /**
         * Create header section
         */
        createHeader() {
            const header = document.createElement('div');
            header.className = 'enscriber-header';
            
            const title = document.createElement('div');
            title.className = 'enscriber-title';
            
            const logo = document.createElement('div');
            logo.className = 'enscriber-logo';
            logo.textContent = 'E';
            
            const titleText = document.createElement('span');
            titleText.textContent = 'Enscriber';
            
            title.appendChild(logo);
            title.appendChild(titleText);
            
            const controls = document.createElement('div');
            controls.className = 'enscriber-controls';
            
            const minimizeBtn = document.createElement('button');
            minimizeBtn.className = 'enscriber-btn';
            minimizeBtn.innerHTML = '−';
            minimizeBtn.title = 'Minimize';
            minimizeBtn.addEventListener('click', () => this.toggleCollapse());
            
            const closeBtn = document.createElement('button');
            closeBtn.className = 'enscriber-btn';
            closeBtn.innerHTML = '×';
            closeBtn.title = 'Close';
            closeBtn.addEventListener('click', () => this.hidePanel());
            
            controls.appendChild(minimizeBtn);
            controls.appendChild(closeBtn);
            
            header.appendChild(title);
            header.appendChild(controls);
            
            return header;
        }

        /**
         * Create content sections
         */
        createContent() {
            const content = document.createElement('div');
            content.className = 'enscriber-content';
            
            // Recording Status Section
            const statusSection = this.createSection('Recording Status', this.createStatusContent());
            content.appendChild(statusSection);
            
            // Page Context Section
            const contextSection = this.createSection('Page Context', this.createContextContent());
            content.appendChild(contextSection);
            
            // Element Selector Section
            const selectorSection = this.createSection('Element Selector', this.createSelectorContent());
            content.appendChild(selectorSection);
            
            // Action List Section
            const actionSection = this.createSection('Recorded Actions', this.createActionListContent());
            content.appendChild(actionSection);
            
            // Network Requests Section
            const networkSection = this.createSection('Network Requests', this.createNetworkRequestsContent());
            content.appendChild(networkSection);
            
            // Notes Section
            const notesSection = this.createSection('Notes', this.createNotesContent());
            content.appendChild(notesSection);
            
            return content;
        }

        /**
         * Create a collapsible section
         */
        createSection(title, content) {
            const section = document.createElement('div');
            section.className = 'enscriber-section';
            
            const header = document.createElement('div');
            header.className = 'enscriber-section-header';
            header.innerHTML = `
                <span>${title}</span>
                <span>▼</span>
            `;
            
            header.addEventListener('click', () => {
                section.classList.toggle('collapsed');
                const arrow = header.querySelector('span:last-child');
                arrow.textContent = section.classList.contains('collapsed') ? '▶' : '▼';
            });
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'enscriber-section-content';
            contentDiv.appendChild(content);
            
            section.appendChild(header);
            section.appendChild(contentDiv);
            
            return section;
        }

        /**
         * Create status content
         */
        createStatusContent() {
            const container = document.createElement('div');
            
            const status = document.createElement('div');
            status.className = 'enscriber-status';
            
            const indicator = document.createElement('div');
            indicator.className = 'enscriber-status-indicator inactive';
            
            const text = document.createElement('span');
            text.textContent = 'Ready to record';
            
            status.appendChild(indicator);
            status.appendChild(text);
            container.appendChild(status);
            
            return container;
        }

        /**
         * Create context content
         */
        createContextContent() {
            const container = document.createElement('div');
            
            const url = document.createElement('div');
            url.className = 'enscriber-text-small enscriber-text-muted';
            url.textContent = window.location.href;
            
            const title = document.createElement('div');
            title.textContent = document.title || 'Untitled Page';
            
            container.appendChild(title);
            container.appendChild(url);
            
            return container;
        }

        /**
         * Create selector content
         */
        createSelectorContent() {
            const container = document.createElement('div');
            container.innerHTML = '<div class="enscriber-text-muted enscriber-text-small">No element selected</div>';
            return container;
        }

        /**
         * Create action list content
         */
        createActionListContent() {
            const container = document.createElement('div');
            const list = document.createElement('ul');
            list.className = 'enscriber-action-list';
            
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'enscriber-text-muted enscriber-text-small';
            emptyMessage.textContent = 'No actions recorded yet';
            
            container.appendChild(emptyMessage);
            container.appendChild(list);
            
            return container;
        }

        /**
         * Create notes content
         */
        createNotesContent() {
            const container = document.createElement('div');
            
            const textarea = document.createElement('textarea');
            textarea.className = 'enscriber-notes-textarea';
            textarea.placeholder = 'Add notes about this recording session...';
            
            container.appendChild(textarea);
            
            return container;
        }

        /**
         * Create network requests content
         */
        createNetworkRequestsContent() {
            const container = document.createElement('div');
            const list = document.createElement('ul');
            list.className = 'enscriber-network-list';
            list.style.cssText = `
                list-style: none;
                margin: 0;
                padding: 0;
            `;
            
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'enscriber-text-muted enscriber-text-small';
            emptyMessage.textContent = 'No network requests captured yet';
            
            container.appendChild(emptyMessage);
            container.appendChild(list);
            
            return container;
        }

        /**
         * Create footer section
         */
        createFooter() {
            const footer = document.createElement('div');
            footer.className = 'enscriber-footer';
            
            const leftSection = document.createElement('div');
            leftSection.className = 'enscriber-footer-left';
            
            const startBtn = document.createElement('button');
            startBtn.className = 'enscriber-btn-primary';
            startBtn.textContent = 'Start Recording';
            startBtn.addEventListener('click', () => this.handleStartRecording());
            
            const modeBtn = document.createElement('button');
            modeBtn.className = 'enscriber-btn-secondary';
            modeBtn.textContent = 'Auto Mode';
            
            leftSection.appendChild(startBtn);
            leftSection.appendChild(modeBtn);
            
            const rightSection = document.createElement('div');
            rightSection.className = 'enscriber-footer-right';
            
            const clearBtn = document.createElement('button');
            clearBtn.className = 'enscriber-btn-secondary';
            clearBtn.textContent = 'Clear';
            clearBtn.title = 'Clear recorded actions';
            clearBtn.addEventListener('click', () => this.handleClearActions());
            
            const exportBtn = document.createElement('button');
            exportBtn.className = 'enscriber-btn-secondary';
            exportBtn.textContent = 'Export';
            exportBtn.addEventListener('click', () => this.handleExport());
            
            const settingsBtn = document.createElement('button');
            settingsBtn.className = 'enscriber-btn-secondary';
            settingsBtn.textContent = '⚙';
            settingsBtn.title = 'Settings';
            settingsBtn.addEventListener('click', () => this.showSettings());
            
            rightSection.appendChild(clearBtn);
            rightSection.appendChild(exportBtn);
            rightSection.appendChild(settingsBtn);
            
            footer.appendChild(leftSection);
            footer.appendChild(rightSection);
            
            return footer;
        }

        /**
         * Create resize handles
         */
        createResizeHandles(panel) {
            const handles = [
                { class: 'top', cursor: 'n-resize' },
                { class: 'bottom', cursor: 's-resize' },
                { class: 'left', cursor: 'w-resize' },
                { class: 'right', cursor: 'e-resize' },
                { class: 'top-left corner', cursor: 'nw-resize' },
                { class: 'top-right corner', cursor: 'ne-resize' },
                { class: 'bottom-left corner', cursor: 'sw-resize' },
                { class: 'bottom-right corner', cursor: 'se-resize' }
            ];
            
            handles.forEach(handle => {
                const element = document.createElement('div');
                element.className = `enscriber-resize-handle ${handle.class}`;
                element.addEventListener('mousedown', (e) => this.startResize(e, handle.class));
                panel.appendChild(element);
            });
        }

        /**
         * Set up event listeners
         */
        setupEventListeners() {
            // Panel dragging
            const header = this.shadowRoot.querySelector('.enscriber-header');
            header.addEventListener('mousedown', this.handleMouseDown);
            
            // Global mouse events for dragging and resizing
            document.addEventListener('mousemove', this.handleMouseMove);
            document.addEventListener('mouseup', this.handleMouseUp);
            
            // Window resize
            window.addEventListener('resize', this.handleResize);
        }

        /**
         * Set up state listeners
         */
        setupStateListeners() {
            this.stateManager.addListener('ui', (newState, prevState) => {
                this.updatePanelFromState(newState, prevState);
            });

            // Listen for recording mode changes
            this.stateManager.addListener('recording', (newState, prevState) => {
                this.updateRecordingStatus(newState, prevState);
            });

            // Listen for element selection changes
            this.stateManager.addListener('selection', (newState, prevState) => {
                this.updateSelectedElement(newState, prevState);
            });

            // Listen for session changes to update action list
            this.stateManager.addListener('ui', (newState, prevState) => {
                // Check if currentSession has changed
                if (newState.currentSession !== prevState.currentSession) {
                    this.updateActionList(newState, prevState);
                }
                
                // Check if networkRequests have changed
                if (newState.networkRequests !== prevState.networkRequests) {
                    this.updateNetworkRequestsList(newState, prevState);
                }
            });
        }

        /**
         * Handle mouse down for dragging
         */
        handleMouseDown(event) {
            if (event.target.closest('.enscriber-controls')) return;
            
            this.isDragging = true;
            this.panelElement.classList.add('dragging');
            
            const rect = this.panelElement.getBoundingClientRect();
            this.dragOffset = {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top
            };
            
            event.preventDefault();
        }

        /**
         * Handle mouse move for dragging and resizing
         */
        handleMouseMove(event) {
            if (this.isDragging) {
                const newX = event.clientX - this.dragOffset.x;
                const newY = event.clientY - this.dragOffset.y;
                
                // Constrain to viewport
                const maxX = window.innerWidth - this.panelElement.offsetWidth;
                const maxY = window.innerHeight - this.panelElement.offsetHeight;
                
                const constrainedX = Math.max(0, Math.min(newX, maxX));
                const constrainedY = Math.max(0, Math.min(newY, maxY));
                
                this.stateManager.setNestedState('ui.panelPosition', {
                    x: constrainedX,
                    y: constrainedY
                });
            }
            
            if (this.isResizing) {
                this.handleResizeMove(event);
            }
        }

        /**
         * Handle mouse up
         */
        handleMouseUp() {
            if (this.isDragging) {
                this.isDragging = false;
                this.panelElement.classList.remove('dragging');
            }
            
            if (this.isResizing) {
                this.isResizing = false;
                this.resizeHandle = null;
            }
        }

        /**
         * Start resize operation
         */
        startResize(event, handleClass) {
            this.isResizing = true;
            this.resizeHandle = handleClass;
            this.resizeStartPos = { x: event.clientX, y: event.clientY };
            this.resizeStartSize = {
                width: this.panelElement.offsetWidth,
                height: this.panelElement.offsetHeight
            };
            event.preventDefault();
            event.stopPropagation();
        }

        /**
         * Handle resize movement
         */
        handleResizeMove(event) {
            if (!this.resizeHandle) return;
            
            const deltaX = event.clientX - this.resizeStartPos.x;
            const deltaY = event.clientY - this.resizeStartPos.y;
            
            let newWidth = this.resizeStartSize.width;
            let newHeight = this.resizeStartSize.height;
            
            if (this.resizeHandle.includes('right')) {
                newWidth = this.resizeStartSize.width + deltaX;
            }
            if (this.resizeHandle.includes('left')) {
                newWidth = this.resizeStartSize.width - deltaX;
            }
            if (this.resizeHandle.includes('bottom')) {
                newHeight = this.resizeStartSize.height + deltaY;
            }
            if (this.resizeHandle.includes('top')) {
                newHeight = this.resizeStartSize.height - deltaY;
            }
            
            // Apply constraints
            newWidth = Math.max(ENSCRIBER_CONFIG.ui.minWidth, Math.min(newWidth, ENSCRIBER_CONFIG.ui.maxWidth));
            newHeight = Math.max(ENSCRIBER_CONFIG.ui.minHeight, Math.min(newHeight, ENSCRIBER_CONFIG.ui.maxHeight));
            
            this.stateManager.setNestedState('ui.panelSize', {
                width: newWidth,
                height: newHeight
            });
        }

        /**
         * Handle window resize
         */
        handleResize() {
            // Ensure panel stays within viewport
            const state = this.stateManager.getState();
            const position = state.ui.panelPosition;
            const size = state.ui.panelSize;
            
            const maxX = window.innerWidth - size.width;
            const maxY = window.innerHeight - size.height;
            
            if (position.x > maxX || position.y > maxY) {
                this.stateManager.setNestedState('ui.panelPosition', {
                    x: Math.max(0, Math.min(position.x, maxX)),
                    y: Math.max(0, Math.min(position.y, maxY))
                });
            }
        }

        /**
         * Update panel transform based on state
         */
        updatePanelTransform() {
            const state = this.stateManager.getState();
            const { panelPosition, panelSize } = state.ui;
            
            if (this.panelElement) {
                this.panelElement.style.transform = `translate(${panelPosition.x}px, ${panelPosition.y}px)`;
                this.panelElement.style.width = `${panelSize.width}px`;
                this.panelElement.style.height = `${panelSize.height}px`;
            }
        }

        /**
         * Update panel from state changes
         */
        updatePanelFromState(newState, prevState) {
            // Update position and size
            if (newState.ui.panelPosition !== prevState.ui.panelPosition ||
                newState.ui.panelSize !== prevState.ui.panelSize) {
                this.updatePanelTransform();
            }
            
            // Update visibility
            if (newState.ui.panelVisible !== prevState.ui.panelVisible) {
                const container = document.getElementById(ENSCRIBER_CONFIG.ui.panelId);
                if (container) {
                    container.style.display = newState.ui.panelVisible ? 'block' : 'none';
                }
            }
            
            // Update collapsed state
            if (newState.ui.isCollapsed !== prevState.ui.isCollapsed) {
                this.panelElement.classList.toggle('collapsed', newState.ui.isCollapsed);
            }
        }

        /**
         * Show the panel
         */
        showPanel() {
            this.stateManager.setNestedState('ui.panelVisible', true);
        }

        /**
         * Hide the panel
         */
        hidePanel() {
            this.stateManager.setNestedState('ui.panelVisible', false);
        }

        /**
         * Toggle panel visibility
         */
        togglePanel() {
            const state = this.stateManager.getState();
            this.stateManager.setNestedState('ui.panelVisible', !state.ui.panelVisible);
        }

        /**
         * Toggle collapsed state
         */
        toggleCollapse() {
            const state = this.stateManager.getState();
            this.stateManager.setNestedState('ui.isCollapsed', !state.ui.isCollapsed);
        }

        /**
         * Handle start recording button click
         */
        handleStartRecording() {
            if (this.recordingEngine) {
                const currentState = this.stateManager.getState();
                
                // Check current mode and toggle appropriately
                if (currentState.mode === ENSCRIBER_CONFIG.modes.INACTIVE) {
                    // Start recording
                    this.recordingEngine.toggleRecording();
                } else if (currentState.mode === ENSCRIBER_CONFIG.modes.MANUAL_SELECTION ||
                          currentState.mode === ENSCRIBER_CONFIG.modes.AUTO_RECORDING) {
                    // Stop recording
                    this.recordingEngine.toggleRecording();
                } else if (currentState.mode === ENSCRIBER_CONFIG.modes.PAUSED) {
                    // Resume recording
                    this.stateManager.setState({
                        mode: ENSCRIBER_CONFIG.modes.MANUAL_SELECTION,
                        isPaused: false
                    });
                }
            }
        }

        /**
         * Update status display
         */
        updateStatus(mode, text) {
            const indicator = this.shadowRoot.querySelector('.enscriber-status-indicator');
            const statusText = this.shadowRoot.querySelector('.enscriber-status span');
            
            if (indicator && statusText) {
                indicator.className = `enscriber-status-indicator ${mode}`;
                statusText.textContent = text;
            }
        }

        /**
         * Update recording status based on state changes
         */
        updateRecordingStatus(newState, prevState) {
            if (newState.mode !== prevState.mode || newState.isRecording !== prevState.isRecording) {
                let statusClass = 'inactive';
                let statusText = 'Ready to record';
                let buttonText = 'Start Recording';

                switch (newState.mode) {
                    case ENSCRIBER_CONFIG.modes.MANUAL_SELECTION:
                        statusClass = 'recording';
                        statusText = 'Manual selection mode - Click elements to select';
                        buttonText = 'Stop Recording';
                        break;
                    case ENSCRIBER_CONFIG.modes.AUTO_RECORDING:
                        statusClass = 'recording';
                        statusText = 'Auto recording mode - Interactions are being recorded';
                        buttonText = 'Stop Recording';
                        break;
                    case ENSCRIBER_CONFIG.modes.PAUSED:
                        statusClass = 'paused';
                        statusText = 'Recording paused';
                        buttonText = 'Resume Recording';
                        break;
                    case ENSCRIBER_CONFIG.modes.INACTIVE:
                        statusClass = 'inactive';
                        statusText = 'Ready to record';
                        buttonText = 'Start Recording';
                        break;
                }

                this.updateStatus(statusClass, statusText);
                
                // Update button text
                const startBtn = this.shadowRoot.querySelector('.enscriber-btn-primary');
                if (startBtn) {
                    startBtn.textContent = buttonText;
                }
                
                console.log(`Enscriber UI: Updated status to ${statusClass}, button text: ${buttonText}`);
            }
        }

        /**
         * Update action list display
         */
        updateActionList(newState, prevState) {
            const actionSection = this.shadowRoot.querySelector('.enscriber-section:nth-child(4) .enscriber-section-content');
            
            if (actionSection) {
                const list = actionSection.querySelector('.enscriber-action-list');
                const emptyMessage = actionSection.querySelector('.enscriber-text-muted');
                
                if (newState.currentSession && newState.currentSession.actions && newState.currentSession.actions.length > 0) {
                    // Hide empty message and show list
                    if (emptyMessage) emptyMessage.style.display = 'none';
                    if (list) list.style.display = 'block';
                    
                    // Clear and populate list
                    if (list) {
                        list.innerHTML = '';
                        newState.currentSession.actions.forEach((action, index) => {
                            const listItem = document.createElement('li');
                            listItem.className = 'enscriber-action-item';
                            listItem.style.cssText = `
                                display: flex;
                                flex-direction: column;
                                gap: 8px;
                                padding: 12px 0;
                                border-bottom: 1px solid #f1f5f9;
                            `;
                            
                            // Main action info row
                            const actionRow = document.createElement('div');
                            actionRow.style.cssText = `
                                display: flex;
                                justify-content: space-between;
                                align-items: flex-start;
                                gap: 8px;
                            `;
                            
                            const actionContent = document.createElement('div');
                            actionContent.style.flex = '1';
                            
                            const actionType = document.createElement('div');
                            actionType.className = 'enscriber-action-type';
                            actionType.textContent = `${index + 1}. ${action.type.toUpperCase()}`;
                            
                            const actionElement = document.createElement('div');
                            actionElement.className = 'enscriber-action-element';
                            
                            let elementDescription = action.element.tagName;
                            if (action.element.id) {
                                elementDescription += `#${action.element.id}`;
                            } else if (action.element.className) {
                                const firstClass = action.element.className.split(' ')[0];
                                elementDescription += `.${firstClass}`;
                            }
                            if (action.element.textContent) {
                                elementDescription += ` "${action.element.textContent.substring(0, 20)}${action.element.textContent.length > 20 ? '...' : ''}"`;
                            }
                            
                            actionElement.textContent = elementDescription;
                            
                            actionContent.appendChild(actionType);
                            actionContent.appendChild(actionElement);
                            
                            // Add action controls
                            const actionControls = document.createElement('div');
                            actionControls.style.cssText = `
                                display: flex;
                                gap: 4px;
                                flex-shrink: 0;
                            `;
                            
                            const editBtn = document.createElement('button');
                            editBtn.textContent = '✏';
                            editBtn.title = 'Edit action';
                            editBtn.style.cssText = `
                                background: #f0f9f4;
                                border: 1px solid #4a7c59;
                                color: #2d5016;
                                width: 20px;
                                height: 20px;
                                border-radius: 3px;
                                cursor: pointer;
                                font-size: 10px;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            `;
                            editBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                this.editAction(index);
                            });
                            
                            const deleteBtn = document.createElement('button');
                            deleteBtn.textContent = '×';
                            deleteBtn.title = 'Delete action';
                            deleteBtn.style.cssText = `
                                background: #fef2f2;
                                border: 1px solid #dc2626;
                                color: #dc2626;
                                width: 20px;
                                height: 20px;
                                border-radius: 3px;
                                cursor: pointer;
                                font-size: 12px;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            `;
                            deleteBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                this.deleteAction(index);
                            });
                            
                            actionControls.appendChild(editBtn);
                            actionControls.appendChild(deleteBtn);
                            
                            actionRow.appendChild(actionContent);
                            actionRow.appendChild(actionControls);
                            
                            // Add notes section if notes exist
                            if (action.notes && action.notes.trim()) {
                                const notesDiv = document.createElement('div');
                                notesDiv.style.cssText = `
                                    background: #f8fafc;
                                    border: 1px solid #e2e8f0;
                                    border-radius: 4px;
                                    padding: 6px 8px;
                                    font-size: 11px;
                                    color: #64748b;
                                    margin-top: 4px;
                                `;
                                notesDiv.innerHTML = `<strong>Notes:</strong> ${action.notes}`;
                                
                                listItem.appendChild(actionRow);
                                listItem.appendChild(notesDiv);
                            } else {
                                listItem.appendChild(actionRow);
                            }
                            
                            list.appendChild(listItem);
                        });
                        
                        // Auto-scroll to the latest action
                        const actionSectionContent = actionSection;
                        actionSectionContent.scrollTop = actionSectionContent.scrollHeight;
                    }
                } else {
                    // Show empty message and hide list
                    if (emptyMessage) emptyMessage.style.display = 'block';
                    if (list) {
                        list.style.display = 'none';
                        list.innerHTML = '';
                    }
                }
            }
        }

        /**
         * Update network requests list display
         */
        updateNetworkRequestsList(newState, prevState) {
            const networkSection = this.shadowRoot.querySelector('.enscriber-section:nth-child(5) .enscriber-section-content');
            
            if (networkSection) {
                const list = networkSection.querySelector('.enscriber-network-list');
                const emptyMessage = networkSection.querySelector('.enscriber-text-muted');
                
                if (newState.networkRequests && newState.networkRequests.length > 0) {
                    // Hide empty message and show list
                    if (emptyMessage) emptyMessage.style.display = 'none';
                    if (list) list.style.display = 'block';
                    
                    // Clear and populate list
                    if (list) {
                        list.innerHTML = '';
                        newState.networkRequests.forEach((request, index) => {
                            const listItem = document.createElement('li');
                            listItem.style.cssText = `
                                display: flex;
                                flex-direction: column;
                                gap: 6px;
                                padding: 10px 0;
                                border-bottom: 1px solid #f1f5f9;
                                font-size: 11px;
                            `;
                            
                            // Request info row
                            const requestRow = document.createElement('div');
                            requestRow.style.cssText = `
                                display: flex;
                                justify-content: space-between;
                                align-items: flex-start;
                                gap: 8px;
                            `;
                            
                            const requestContent = document.createElement('div');
                            requestContent.style.flex = '1';
                            
                            const methodAndStatus = document.createElement('div');
                            methodAndStatus.style.cssText = `
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                margin-bottom: 2px;
                            `;
                            
                            const methodBadge = document.createElement('span');
                            methodBadge.textContent = request.method;
                            methodBadge.style.cssText = `
                                background: ${this.getMethodColor(request.method)};
                                color: white;
                                padding: 2px 6px;
                                border-radius: 3px;
                                font-size: 9px;
                                font-weight: 500;
                            `;
                            
                            const statusBadge = document.createElement('span');
                            statusBadge.textContent = request.status || 'Pending';
                            statusBadge.style.cssText = `
                                background: ${this.getStatusColor(request.status)};
                                color: white;
                                padding: 2px 6px;
                                border-radius: 3px;
                                font-size: 9px;
                                font-weight: 500;
                            `;
                            
                            methodAndStatus.appendChild(methodBadge);
                            methodAndStatus.appendChild(statusBadge);
                            
                            const urlDiv = document.createElement('div');
                            urlDiv.style.cssText = `
                                color: #64748b;
                                font-size: 10px;
                                word-break: break-all;
                                line-height: 1.3;
                            `;
                            
                            // Truncate long URLs
                            const url = request.url;
                            const maxLength = 60;
                            urlDiv.textContent = url.length > maxLength ? url.substring(0, maxLength) + '...' : url;
                            urlDiv.title = url;
                            
                            requestContent.appendChild(methodAndStatus);
                            requestContent.appendChild(urlDiv);
                            
                            // Add to actions button
                            const addButton = document.createElement('button');
                            addButton.textContent = '+';
                            addButton.title = 'Add to actions';
                            addButton.style.cssText = `
                                background: #f0f9f4;
                                border: 1px solid #4a7c59;
                                color: #2d5016;
                                width: 24px;
                                height: 24px;
                                border-radius: 4px;
                                cursor: pointer;
                                font-size: 12px;
                                font-weight: bold;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                flex-shrink: 0;
                            `;
                            
                            addButton.addEventListener('click', (e) => {
                                e.stopPropagation();
                                this.addNetworkRequestToActions(request);
                            });
                            
                            requestRow.appendChild(requestContent);
                            requestRow.appendChild(addButton);
                            listItem.appendChild(requestRow);
                            
                            list.appendChild(listItem);
                        });
                        
                        // Auto-scroll to the latest request
                        const networkSectionContent = networkSection;
                        networkSectionContent.scrollTop = networkSectionContent.scrollHeight;
                    }
                } else {
                    // Show empty message and hide list
                    if (emptyMessage) emptyMessage.style.display = 'block';
                    if (list) {
                        list.style.display = 'none';
                        list.innerHTML = '';
                    }
                }
            }
        }

        /**
         * Get color for HTTP method badge
         */
        getMethodColor(method) {
            const colors = {
                'GET': '#10b981',
                'POST': '#3b82f6',
                'PUT': '#f59e0b',
                'DELETE': '#ef4444',
                'PATCH': '#8b5cf6',
                'HEAD': '#6b7280',
                'OPTIONS': '#6b7280'
            };
            return colors[method] || '#6b7280';
        }

        /**
         * Get color for status code badge
         */
        getStatusColor(status) {
            if (!status) return '#6b7280';
            
            if (status >= 200 && status < 300) return '#10b981';
            if (status >= 300 && status < 400) return '#f59e0b';
            if (status >= 400 && status < 500) return '#ef4444';
            if (status >= 500) return '#dc2626';
            return '#6b7280';
        }

        /**
         * Add network request to actions list
         */
        addNetworkRequestToActions(request) {
            if (this.recordingEngine && this.recordingEngine.networkMonitor) {
                // Show action type selection dialog
                this.showNetworkActionDialog(request);
            }
        }

        /**
         * Show dialog to select network action type
         */
        showNetworkActionDialog(request) {
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                z-index: ${ENSCRIBER_CONFIG.ui.zIndex + 1};
                display: flex;
                align-items: center;
                justify-content: center;
            `;
            
            const content = document.createElement('div');
            content.style.cssText = `
                background: white;
                border-radius: 8px;
                padding: 20px;
                width: 400px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            `;
            
            content.innerHTML = `
                <h3 style="margin: 0 0 15px 0; color: #333;">Add Network Request to Actions</h3>
                <div style="margin-bottom: 15px; padding: 10px; background: #f8fafc; border-radius: 4px; font-size: 12px;">
                    <div><strong>${request.method}</strong> ${request.url}</div>
                    <div style="color: #64748b; margin-top: 4px;">Status: ${request.status || 'Pending'}</div>
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Action Type:</label>
                    <select id="network-action-type" style="width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
                        <option value="waitForResponse">Wait for Response</option>
                        <option value="route">Route/Mock Request</option>
                        <option value="waitForRequest">Wait for Request</option>
                    </select>
                </div>
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Notes:</label>
                    <textarea id="network-action-notes" style="width: 100%; height: 60px; padding: 5px; border: 1px solid #ddd; border-radius: 4px; resize: vertical;" placeholder="Add notes for this network action..."></textarea>
                </div>
                <div style="text-align: right;">
                    <button id="add-network-action" style="
                        background: #4a7c59;
                        color: white;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        margin-right: 10px;
                        cursor: pointer;
                    ">Add to Actions</button>
                    <button id="cancel-network-action" style="
                        background: #e2e8f0;
                        color: #4a5568;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                    ">Cancel</button>
                </div>
            `;
            
            dialog.appendChild(content);
            document.body.appendChild(dialog);
            
            // Add event listeners
            content.querySelector('#add-network-action').addEventListener('click', () => {
                const actionType = content.querySelector('#network-action-type').value;
                const notes = content.querySelector('#network-action-notes').value;
                
                // Add the request to actions with custom notes
                this.recordingEngine.networkMonitor.addRequestToActions(request, actionType);
                
                // Update the action notes if provided
                if (notes.trim()) {
                    const state = this.stateManager.getState();
                    if (state.currentSession && state.currentSession.actions.length > 0) {
                        const lastAction = state.currentSession.actions[state.currentSession.actions.length - 1];
                        lastAction.notes = notes;
                        
                        this.stateManager.setState({
                            currentSession: {
                                ...state.currentSession,
                                actions: [...state.currentSession.actions]
                            }
                        });
                    }
                }
                
                document.body.removeChild(dialog);
            });
            
            content.querySelector('#cancel-network-action').addEventListener('click', () => {
                document.body.removeChild(dialog);
            });
            
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) {
                    document.body.removeChild(dialog);
                }
            });
        }

        /**
         * Handle clear actions functionality
         */
        handleClearActions() {
            const state = this.stateManager.getState();
            if (!state.currentSession || !state.currentSession.actions || state.currentSession.actions.length === 0) {
                alert('No actions to clear.');
                return;
            }
            
            if (confirm(`Are you sure you want to clear all ${state.currentSession.actions.length} recorded actions? This cannot be undone.`)) {
                // Clear actions from current session
                this.stateManager.setState({
                    currentSession: {
                        ...state.currentSession,
                        actions: []
                    }
                });
                
                // Also clear network requests
                this.stateManager.setState({
                    networkRequests: []
                });
                
                // Clear from network monitor
                if (this.recordingEngine && this.recordingEngine.networkMonitor) {
                    this.recordingEngine.networkMonitor.clearCapturedRequests();
                }
                
                console.log('Enscriber: All actions and network requests cleared');
            }
        }

        /**
         * Edit an action in the list
         */
        editAction(actionIndex) {
            const state = this.stateManager.getState();
            if (!state.currentSession || !state.currentSession.actions || actionIndex >= state.currentSession.actions.length) {
                return;
            }
            
            const action = state.currentSession.actions[actionIndex];
            
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                z-index: ${ENSCRIBER_CONFIG.ui.zIndex + 1};
                display: flex;
                align-items: center;
                justify-content: center;
            `;
            
            const content = document.createElement('div');
            content.style.cssText = `
                background: white;
                border-radius: 8px;
                padding: 20px;
                width: 400px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            `;
            
            content.innerHTML = `
                <h3 style="margin: 0 0 20px 0; color: #333;">Edit Action ${actionIndex + 1}</h3>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Action Type:</label>
                    <select id="action-type" style="width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
                        <option value="click" ${action.type === 'click' ? 'selected' : ''}>Click</option>
                        <option value="input" ${action.type === 'input' ? 'selected' : ''}>Input</option>
                        <option value="hover" ${action.type === 'hover' ? 'selected' : ''}>Hover</option>
                        <option value="check" ${action.type === 'check' ? 'selected' : ''}>Check</option>
                        <option value="select" ${action.type === 'select' ? 'selected' : ''}>Select</option>
                    </select>
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Value:</label>
                    <input type="text" id="action-value" value="${action.value || ''}" style="width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
                </div>
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Notes:</label>
                    <textarea id="action-notes" style="width: 100%; height: 60px; padding: 5px; border: 1px solid #ddd; border-radius: 4px; resize: vertical;" placeholder="Add notes for this action...">${action.notes || ''}</textarea>
                </div>
                <div style="text-align: right;">
                    <button id="save-action" style="
                        background: #4a7c59;
                        color: white;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        margin-right: 10px;
                        cursor: pointer;
                    ">Save</button>
                    <button id="cancel-action" style="
                        background: #e2e8f0;
                        color: #4a5568;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                    ">Cancel</button>
                </div>
            `;
            
            dialog.appendChild(content);
            document.body.appendChild(dialog);
            
            // Add event listeners
            content.querySelector('#save-action').addEventListener('click', () => {
                const updatedAction = {
                    ...action,
                    type: content.querySelector('#action-type').value,
                    value: content.querySelector('#action-value').value,
                    notes: content.querySelector('#action-notes').value
                };
                
                const updatedActions = [...state.currentSession.actions];
                updatedActions[actionIndex] = updatedAction;
                
                this.stateManager.setState({
                    currentSession: {
                        ...state.currentSession,
                        actions: updatedActions
                    }
                });
                
                document.body.removeChild(dialog);
            });
            
            content.querySelector('#cancel-action').addEventListener('click', () => {
                document.body.removeChild(dialog);
            });
            
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) {
                    document.body.removeChild(dialog);
                }
            });
        }

        /**
         * Delete an action from the list
         */
        deleteAction(actionIndex) {
            const state = this.stateManager.getState();
            if (!state.currentSession || !state.currentSession.actions || actionIndex >= state.currentSession.actions.length) {
                return;
            }
            
            if (confirm(`Are you sure you want to delete action ${actionIndex + 1}?`)) {
                const updatedActions = state.currentSession.actions.filter((_, index) => index !== actionIndex);
                
                this.stateManager.setState({
                    currentSession: {
                        ...state.currentSession,
                        actions: updatedActions
                    }
                });
            }
        }

        /**
         * Update selected element display
         */
        updateSelectedElement(newState, prevState) {
            if (newState.selectedElement !== prevState.selectedElement) {
                const selectorContent = this.shadowRoot.querySelector('.enscriber-section:nth-child(3) .enscriber-section-content');
                
                if (selectorContent) {
                    if (newState.selectedElement) {
                        const metadata = newState.selectedElement.metadata;
                        selectorContent.innerHTML = `
                            <div>
                                <div><strong>Tag:</strong> ${metadata.tagName}</div>
                                ${metadata.id ? `<div><strong>ID:</strong> ${metadata.id}</div>` : ''}
                                ${metadata.className ? `<div><strong>Class:</strong> ${metadata.className}</div>` : ''}
                                ${metadata.textContent ? `<div><strong>Text:</strong> ${metadata.textContent}</div>` : ''}
                                <div class="enscriber-text-small enscriber-text-muted">
                                    Position: ${Math.round(metadata.position.x)}, ${Math.round(metadata.position.y)}
                                </div>
                                <div class="enscriber-text-small enscriber-text-muted">
                                    Size: ${Math.round(metadata.position.width)} × ${Math.round(metadata.position.height)}
                                </div>
                            </div>
                        `;
                    } else {
                        selectorContent.innerHTML = '<div class="enscriber-text-muted enscriber-text-small">No element selected</div>';
                    }
                }
            }
        }

        /**
         * Handle export functionality
         */
        handleExport() {
            const state = this.stateManager.getState();
            if (!state.currentSession || !state.currentSession.actions || state.currentSession.actions.length === 0) {
                alert('No actions recorded to export. Start recording and select some elements first.');
                return;
            }

            const playwrightCode = this.generatePlaywrightCode(state.currentSession);
            this.showExportDialog(playwrightCode);
        }

        /**
         * Generate Playwright code from recorded actions
         */
        generatePlaywrightCode(session) {
            const actions = session.actions;
            let code = `// Generated Playwright automation script\n`;
            code += `// Session: ${session.name}\n`;
            code += `// URL: ${session.url}\n`;
            code += `// Generated: ${new Date().toLocaleString()}\n\n`;
            
            code += `import { test, expect } from '@playwright/test';\n\n`;
            code += `test('${session.name}', async ({ page }) => {\n`;
            code += `  // Navigate to the page\n`;
            code += `  await page.goto('${session.url}');\n\n`;
            
            actions.forEach((action, index) => {
                if (action.networkRequest) {
                    // Handle network request actions
                    code += `  // Network Action ${index + 1}: ${action.type} for ${action.networkRequest.method} ${action.networkRequest.url}\n`;
                    
                    if (action.notes) {
                        code += `  // Notes: ${action.notes}\n`;
                    }
                    
                    switch (action.type) {
                        case 'waitForResponse':
                            code += `  const response${index} = await page.waitForResponse('${action.networkRequest.url}');\n`;
                            code += `  expect(response${index}.status()).toBe(${action.networkRequest.status || 200});\n`;
                            break;
                        case 'waitForRequest':
                            code += `  const request${index} = await page.waitForRequest('${action.networkRequest.url}');\n`;
                            code += `  expect(request${index}.method()).toBe('${action.networkRequest.method}');\n`;
                            break;
                        case 'route':
                            code += `  // Mock/route the request\n`;
                            code += `  await page.route('${action.networkRequest.url}', route => {\n`;
                            code += `    route.fulfill({\n`;
                            code += `      status: ${action.networkRequest.status || 200},\n`;
                            code += `      contentType: 'application/json',\n`;
                            code += `      body: JSON.stringify({ /* mock response data */ })\n`;
                            code += `    });\n`;
                            code += `  });\n`;
                            break;
                    }
                } else if (action.element) {
                    // Handle element actions
                    code += `  // Action ${index + 1}: ${action.type} on ${action.element.tagName}`;
                    if (action.element.id) code += `#${action.element.id}`;
                    if (action.element.className) code += `.${action.element.className.split(' ')[0]}`;
                    code += `\n`;
                    
                    if (action.notes) {
                        code += `  // Notes: ${action.notes}\n`;
                    }
                    
                    // Generate selector priority: ID > data-testid > class > text > xpath
                    let selector = '';
                    if (action.element.id) {
                        selector = `#${action.element.id}`;
                    } else if (action.element.attributes && action.element.attributes['data-testid']) {
                        selector = `[data-testid="${action.element.attributes['data-testid']}"]`;
                    } else if (action.element.className) {
                        const firstClass = action.element.className.split(' ')[0];
                        selector = `.${firstClass}`;
                    } else if (action.element.textContent) {
                        selector = `text="${action.element.textContent.substring(0, 30)}"`;
                    } else {
                        selector = action.element.xpath;
                    }
                    
                    switch (action.type) {
                        case 'click':
                            code += `  await page.click('${selector}');\n`;
                            break;
                        case 'input':
                            code += `  await page.fill('${selector}', '${action.value || ''}');\n`;
                            break;
                        case 'hover':
                            code += `  await page.hover('${selector}');\n`;
                            break;
                        case 'check':
                            if (action.value === 'checked') {
                                code += `  await page.check('${selector}');\n`;
                            } else {
                                code += `  await page.uncheck('${selector}');\n`;
                            }
                            break;
                        case 'select':
                            code += `  await page.selectOption('${selector}', '${action.value || ''}');\n`;
                            break;
                        default:
                            code += `  await page.click('${selector}');\n`;
                    }
                }
                code += `\n`;
            });
            
            code += `  // Add assertions as needed\n`;
            code += `  // await expect(page).toHaveTitle(/Expected Title/);\n`;
            code += `});\n`;
            
            return code;
        }

        /**
         * Show export dialog with generated code
         */
        showExportDialog(code) {
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                z-index: ${ENSCRIBER_CONFIG.ui.zIndex + 1};
                display: flex;
                align-items: center;
                justify-content: center;
            `;
            
            const content = document.createElement('div');
            content.style.cssText = `
                background: white;
                border-radius: 8px;
                padding: 20px;
                max-width: 80%;
                max-height: 80%;
                overflow: auto;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            `;
            
            content.innerHTML = `
                <h3 style="margin: 0 0 15px 0; color: #333;">Export Playwright Code</h3>
                <textarea readonly style="
                    width: 100%;
                    height: 400px;
                    font-family: 'Courier New', monospace;
                    font-size: 12px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    padding: 10px;
                    resize: vertical;
                ">${code}</textarea>
                <div style="margin-top: 15px; text-align: right;">
                    <button id="copy-code" style="
                        background: #667eea;
                        color: white;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        margin-right: 10px;
                        cursor: pointer;
                    ">Copy Code</button>
                    <button id="close-dialog" style="
                        background: #e2e8f0;
                        color: #4a5568;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                    ">Close</button>
                </div>
            `;
            
            dialog.appendChild(content);
            document.body.appendChild(dialog);
            
            // Add event listeners
            content.querySelector('#copy-code').addEventListener('click', () => {
                const textarea = content.querySelector('textarea');
                textarea.select();
                document.execCommand('copy');
                alert('Code copied to clipboard!');
            });
            
            content.querySelector('#close-dialog').addEventListener('click', () => {
                document.body.removeChild(dialog);
            });
            
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) {
                    document.body.removeChild(dialog);
                }
            });
        }

        /**
         * Show settings dialog
         */
        showSettings() {
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                z-index: ${ENSCRIBER_CONFIG.ui.zIndex + 1};
                display: flex;
                align-items: center;
                justify-content: center;
            `;
            
            const content = document.createElement('div');
            content.style.cssText = `
                background: white;
                border-radius: 8px;
                padding: 20px;
                width: 400px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            `;
            
            const state = this.stateManager.getState();
            content.innerHTML = `
                <h3 style="margin: 0 0 20px 0; color: #333;">Enscriber Settings</h3>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">
                        <input type="checkbox" id="auto-save" ${state.settings.autoSave ? 'checked' : ''}>
                        Auto-save sessions
                    </label>
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">
                        <input type="checkbox" id="highlight-elements" ${state.settings.highlightElements ? 'checked' : ''}>
                        Highlight elements on hover
                    </label>
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">
                        <input type="checkbox" id="show-tooltips" ${state.settings.showTooltips ? 'checked' : ''}>
                        Show element tooltips
                    </label>
                </div>
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500;">Recording Mode:</label>
                    <select id="recording-mode" style="width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
                        <option value="manual" ${state.settings.recordingMode === 'manual' ? 'selected' : ''}>Manual Selection</option>
                        <option value="auto" ${state.settings.recordingMode === 'auto' ? 'selected' : ''}>Auto Recording</option>
                    </select>
                </div>
                <div style="text-align: right;">
                    <button id="save-settings" style="
                        background: #667eea;
                        color: white;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        margin-right: 10px;
                        cursor: pointer;
                    ">Save</button>
                    <button id="cancel-settings" style="
                        background: #e2e8f0;
                        color: #4a5568;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                    ">Cancel</button>
                </div>
            `;
            
            dialog.appendChild(content);
            document.body.appendChild(dialog);
            
            // Add event listeners
            content.querySelector('#save-settings').addEventListener('click', () => {
                const newSettings = {
                    autoSave: content.querySelector('#auto-save').checked,
                    highlightElements: content.querySelector('#highlight-elements').checked,
                    showTooltips: content.querySelector('#show-tooltips').checked,
                    recordingMode: content.querySelector('#recording-mode').value
                };
                
                this.stateManager.setState({ settings: newSettings });
                document.body.removeChild(dialog);
                alert('Settings saved!');
            });
            
            content.querySelector('#cancel-settings').addEventListener('click', () => {
                document.body.removeChild(dialog);
            });
            
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) {
                    document.body.removeChild(dialog);
                }
            });
        }

        /**
         * Clean up resources
         */
        destroy() {
            // Remove event listeners
            document.removeEventListener('mousemove', this.handleMouseMove);
            document.removeEventListener('mouseup', this.handleMouseUp);
            window.removeEventListener('resize', this.handleResize);
            
            // Remove panel from DOM
            const container = document.getElementById(ENSCRIBER_CONFIG.ui.panelId);
            if (container) {
                container.remove();
            }
            
            console.log('Enscriber UI: Destroyed');
        }
    }

    // ============================================================================
    // APPLICATION INITIALIZATION
    // ============================================================================

    /**
     * Initialize the Enscriber application
     */
    async function initializeEnscriber() {
        try {
            // Check if already initialized
            if (window.enscriber) {
                console.warn('Enscriber: Already initialized');
                return;
            }

            // Create and initialize core
            const core = new EnscribeCore();
            await core.initialize();

            // Make available globally for debugging
            window.enscriber = core;

            // Show panel by default
            core.uiManager.showPanel();

            console.log('Enscriber: Successfully initialized and ready to use');
            console.log('Press Ctrl+Shift+E to toggle the panel');

        } catch (error) {
            console.error('Enscriber: Failed to initialize:', error);
        }
    }

    // ============================================================================
    // STARTUP
    // ============================================================================

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeEnscriber);
    } else {
        // DOM is already ready
        initializeEnscriber();
    }

})();