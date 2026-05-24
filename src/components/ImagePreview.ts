import { GifPreviewProps } from '../types/post.js'
import { safeRemoveFromBody } from '../lib/dom-utils.js'
import { registerModal } from '../lib/modal-state.js'
import { t } from '../lib/i18n.js'

export function createImagePreview(props: GifPreviewProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'image-preview'
  
  if (!props.gifKey) {
    // Fallback for posts without image
    const fallback = document.createElement('div')
    fallback.className = 'image-preview-error'
    fallback.textContent = t('image_preview.no_preview')
    container.appendChild(fallback)
    return container
  }
  
  // Add aspect ratio container to prevent CLS
  const aspectRatioContainer = document.createElement('div')
  aspectRatioContainer.className = 'image-preview-aspect-ratio'
  aspectRatioContainer.style.cssText = `
    position: relative;
    width: 100%;
    padding-bottom: 56.25%; /* 16:9 aspect ratio */
    background: var(--bg-input);
    border-radius: 8px;
    overflow: hidden;
  `
  
  // Add loading indicator
  const loading = document.createElement('div')
  loading.className = 'image-preview-loading'
  loading.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-input);
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.875rem;
  `
  loading.textContent = t('common.loading')
  
  // Create image container with proper sizing
  const imageContainer = document.createElement('div')
  imageContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  `
  
  const img = document.createElement('img')
  img.className = 'image-preview-img'
  img.alt = t('image_preview.post_preview', { id: props.postId })
  img.loading = 'lazy'
  img.style.cssText = `
    width: 100%;
    height: 100%;
    object-fit: cover;
    cursor: pointer;
    transition: opacity 0.2s ease;
    image-rendering: -webkit-optimize-contrast;
    image-rendering: auto;
    image-rendering: smooth;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    backface-visibility: hidden;
    transform: translateZ(0);
    filter: contrast(1.1) brightness(1.05);
  `
  
  // Use the API proxy endpoint for images
  const imageUrl = `/api/images/${props.gifKey}`
  img.src = imageUrl
  
  // Handle image load success
  img.onload = () => {
    loading.style.display = 'none'
    img.style.opacity = '1'
  }
  
  // Handle image loading errors
  img.onerror = () => {
    loading.style.display = 'none'
    img.style.display = 'none'
    const fallback = document.createElement('div')
    fallback.className = 'image-preview-error'
    fallback.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-secondary);
      color: var(--text-muted);
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 0.875rem;
      text-align: center;
      padding: 2rem;
    `
    fallback.textContent = t('image_preview.load_failed')
    imageContainer.appendChild(fallback)
  }
  
  // Set initial opacity for smooth loading
  img.style.opacity = '0'
  
  // Add click handler for overlay display
  img.onclick = (e) => {
    e.stopPropagation() // Prevent post card click
    createImageOverlay(imageUrl, props.postId)
  }
  
  imageContainer.appendChild(img)
  aspectRatioContainer.appendChild(loading)
  aspectRatioContainer.appendChild(imageContainer)
  container.appendChild(aspectRatioContainer)
  return container
}

// Create image overlay modal
function createImageOverlay(imageUrl: string, postId: string): void {
  // Create overlay container
  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    cursor: pointer;
  `
  
  // Create image container
  const imageContainer = document.createElement('div')
  imageContainer.style.cssText = `
    width: 90vw;
    height: 90vh;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  `
  
  // Create full-size image
  const fullImage = document.createElement('img')
  fullImage.src = imageUrl
  fullImage.alt = t('image_preview.post_full_size', { id: postId })
  fullImage.style.cssText = `
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  `
  
  // Create close button
  const closeButton = document.createElement('button')
  closeButton.textContent = t('image_preview.close')
  closeButton.style.cssText = `
    position: absolute;
    top: 8px;
    right: 0;
    background: rgba(255, 255, 255, 0.2);
    border: none;
    color: white;
    font-size: 24px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s ease;
  `
  
  closeButton.onmouseover = () => closeButton.style.background = 'rgba(255, 255, 255, 0.3)'
  closeButton.onmouseout = () => closeButton.style.background = 'rgba(255, 255, 255, 0.2)'
  
  // Close handlers
  const unregister = registerModal()
  const closeOverlay = () => {
    unregister()
    safeRemoveFromBody(overlay)
  }
  
  closeButton.onclick = (e) => {
    e.stopPropagation()
    closeOverlay()
  }
  
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      closeOverlay()
    }
  }
  
  // Handle ESC key
  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeOverlay()
      document.removeEventListener('keydown', handleEsc)
    }
  }
  document.addEventListener('keydown', handleEsc)
  
  // Assemble overlay
  imageContainer.appendChild(fullImage)
  imageContainer.appendChild(closeButton)
  overlay.appendChild(imageContainer)
  
  // Add to body
  document.body.appendChild(overlay)
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  return createImagePreview(props)
}
