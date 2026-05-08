import { PostStageProps, PostCardMode } from '../types/post.js'
import { createImagePreview } from './ImagePreview.js'
import { createAudioPlayer } from './AudioPlayer.js'
import { executeZipAuto } from '../lib/zip-manager.js'
import { executeFlash } from './FlashPlayer.js'

// Create SWF execution button (similar to ZIP but for Flash)
function createSwfExecutionButton(props: {
  postId: string
  label: string
  icon: string
  onClick: () => void
}): HTMLElement {
  const container = document.createElement('div')
  container.className = 'execution-button'
  container.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    cursor: pointer;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border-radius: 8px;
    transition: all 0.2s ease;
    padding: 20px;
  `

  // Icon
  const icon = document.createElement('div')
  icon.textContent = props.icon
  icon.style.cssText = `
    font-size: 48px;
    margin-bottom: 12px;
  `

  // Text
  const text = document.createElement('div')
  text.textContent = props.label
  text.style.cssText = `
    font-size: 16px;
    font-weight: 600;
    text-align: center;
  `

  container.appendChild(icon)
  container.appendChild(text)

  // Hover effects
  container.addEventListener('mouseenter', () => {
    container.style.transform = 'scale(1.02)'
    container.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)'
  })

  container.addEventListener('mouseleave', () => {
    container.style.transform = 'scale(1)'
    container.style.boxShadow = 'none'
  })

  // Click handler - directly trigger mode change for SWF
  container.addEventListener('click', async (e) => {
    e.stopPropagation()
    
    // Show loading state
    const originalContent = container.innerHTML
    container.innerHTML = '<span style="font-size: 20px;">⏳</span><span>Loading Flash...</span>'
    container.style.pointerEvents = 'none'

    try {
      // For SWF, just trigger the mode change to show Flash player
      props.onClick()
      
    } catch (error) {
      console.error('Failed to load SWF:', error)
      container.innerHTML = originalContent
      container.style.pointerEvents = 'auto'
      alert('Failed to load Flash file. Please try again.')
    }
  })

  return container
}

// Load JSZip dynamically
declare const JSZip: any

async function loadJSZip(): Promise<any> {
  if (typeof window !== 'undefined' && (window as any).JSZip) {
    return (window as any).JSZip
  }
  
  // Load JSZip from CDN if not available
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
    script.onload = () => resolve((window as any).JSZip)
    script.onerror = reject
    document.head.appendChild(script)
  })
}

async function validateZipContainsIndexHtml(zipBlob: Blob): Promise<boolean> {
  try {
    const JSZip = await loadJSZip()
    const zip = await JSZip.loadAsync(zipBlob)
    
    // Check if index.html exists in the ZIP
    const hasIndexHtml = zip.file('index.html') !== null || 
                       zip.file('index.htm') !== null ||
                       zip.files['index.html'] !== null ||
                       zip.files['index.htm'] !== null
    
    return hasIndexHtml
  } catch (error) {
    console.error('Error validating ZIP:', error)
    return false
  }
}

interface ZipExecutionButtonProps {
  postId: string
  label: string
  icon: string
  onClick: () => void
}

function createExecutionButton(props: ZipExecutionButtonProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'zip-execution-button'
  container.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: white;
    font-weight: 600;
    font-size: 16px;
    gap: 8px;
  `

  const icon = document.createElement('span')
  icon.textContent = props.icon
  icon.style.fontSize = '24px'

  const text = document.createElement('span')
  text.textContent = props.label

  container.appendChild(icon)
  container.appendChild(text)

  // Hover effects
  container.addEventListener('mouseenter', () => {
    container.style.transform = 'scale(1.02)'
    container.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)'
  })

  container.addEventListener('mouseleave', () => {
    container.style.transform = 'scale(1)'
    container.style.boxShadow = 'none'
  })

  // Click handler
  container.addEventListener('click', async (e) => {
    e.stopPropagation()
    
    // Show loading state
    const originalContent = container.innerHTML
    container.innerHTML = '<span style="font-size: 20px;">⏳</span><span>Loading...</span>'
    container.style.pointerEvents = 'none'

    try {
      // Fetch ZIP file
      const response = await fetch(`/api/zip/${props.postId}`)
      if (!response.ok) {
        throw new Error('Failed to fetch ZIP file')
      }

      // Get ZIP blob
      const zipBlob = await response.blob()
      
      // Validate ZIP contains index.html
      const hasIndexHtml = await validateZipContainsIndexHtml(zipBlob)
      if (!hasIndexHtml) {
        throw new Error('ZIP file must contain index.html')
      }
      
      // For now, just log that we would execute the ZIP
      // The actual execution engine will be implemented separately
      console.log('execute', props.postId, zipBlob)
      
      // Trigger the mode change to show sandbox
      props.onClick()
      
    } catch (error) {
      console.error('Failed to load ZIP:', error)
      container.innerHTML = originalContent
      container.style.pointerEvents = 'auto'
      alert('Failed to load ZIP file. Please try again.')
    }
  })

  return container
}

// Create thumbnail with overlay button for ZIP/SWF posts
function createThumbnailWithOverlay(props: {
  postId: string
  thumbnailKey: string
  overlayLabel: string
  aspectRatio?: string
  onClick: () => void
}): HTMLElement {
  const container = document.createElement('div')
  container.className = 'thumbnail-overlay-container'
  
  // Determine aspect ratio (default to 16:9)
  const aspectRatio = props.aspectRatio || '56.25' // 16:9 = 56.25%
  
  container.style.cssText = `
    position: relative;
    width: 100%;
    padding-bottom: ${aspectRatio}%;
    background: var(--bg-input);
    border-radius: 8px;
    overflow: hidden;
  `

  // Image container
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

  // Thumbnail image
  const image = document.createElement('img')
  image.src = `/api/thumbnail/${props.postId}`
  image.style.cssText = `
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    transition: opacity 0.3s ease;
    image-rendering: -webkit-optimize-contrast;
    image-rendering: auto;
    image-rendering: smooth;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    backface-visibility: hidden;
    transform: translateZ(0);
    filter: contrast(1.1) brightness(1.05);
  `
  
  // Load image with fade-in
  image.onload = () => {
    image.style.opacity = '1'
  }
  
  image.onerror = () => {
    // Show fallback on error
    image.style.display = 'none'
    const fallback = document.createElement('div')
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
    `
    fallback.textContent = 'Thumbnail unavailable'
    imageContainer.appendChild(fallback)
  }
  
  // Overlay button
  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.7);
    color: white;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s ease;
    pointer-events: none;
    z-index: 2;
  `
  overlay.textContent = props.overlayLabel

  imageContainer.appendChild(image)
  imageContainer.appendChild(overlay)
  container.appendChild(imageContainer)

  // Hover effects
  container.addEventListener('mouseenter', () => {
    overlay.style.background = 'rgba(0, 0, 0, 0.8)'
    overlay.style.transform = 'translate(-50%, -50%) scale(1.05)'
  })

  container.addEventListener('mouseleave', () => {
    overlay.style.background = 'rgba(0, 0, 0, 0.7)'
    overlay.style.transform = 'translate(-50%, -50%) scale(1)'
  })

  // Click handler - trigger execution
  container.addEventListener('click', (e) => {
    e.stopPropagation()
    props.onClick()
  })

  return container
}

export function createPostStage(props: PostStageProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'post-stage'
  
  // Click handler to toggle between preview and execution modes
  // Only for non-ZIP files - ZIP files have their own button
  container.addEventListener('click', (e) => {
    // Don't toggle mode if clicking on execution button (ZIP or SWF)
    if ((e.target as HTMLElement).closest('.zip-execution-button')) {
      return
    }
    
    const newMode = props.mode === PostCardMode.PREVIEW 
      ? PostCardMode.EXECUTING 
      : PostCardMode.PREVIEW
    props.onModeChange(newMode)
  })
  
  // Render current mode
  updateStageContent(container, props).catch(error => {
    console.error('Error updating stage content:', error)
  })
  
  return container
}

async function updateStageContent(container: HTMLElement, props: PostStageProps): Promise<void> {
  // Clear existing content
  container.innerHTML = ''
  
  // Only show content if there are attachments
  if (!props.post.gif_key && !props.post.payload_key && !props.post.swf_key) {
    return
  }
  
  if (props.mode === PostCardMode.PREVIEW) {
    let mediaElement
    
    // Check if it's a ZIP file (payload_key starting with 'zip/')
    if (props.post.payload_key && props.post.payload_key.startsWith('zip/')) {
      if (props.post.thumbnail_key) {
        // Show thumbnail with overlay button
        mediaElement = createThumbnailWithOverlay({
          postId: props.post.id,
          thumbnailKey: props.post.thumbnail_key,
          overlayLabel: '🚀 Run',
          aspectRatio: '56.25', // 16:9
          onClick: () => props.onModeChange(PostCardMode.EXECUTING)
        })
      } else {
        // Create ZIP execution button (existing behavior)
        mediaElement = createExecutionButton({
          postId: props.post.id,
          label: 'Click to Execute ZIP',
          icon: '🚀',
          onClick: () => props.onModeChange(PostCardMode.EXECUTING)
        })
      }
    } else if (props.post.swf_key && props.post.swf_key.startsWith('swf/')) {
      if (props.post.thumbnail_key) {
        // Show thumbnail with overlay button
        mediaElement = createThumbnailWithOverlay({
          postId: props.post.id,
          thumbnailKey: props.post.thumbnail_key,
          overlayLabel: '⚡ Play',
          aspectRatio: '75', // 4:3 = 75%
          onClick: () => props.onModeChange(PostCardMode.EXECUTING)
        })
        // Add flash class for 4:3 aspect ratio
        container.classList.add('post-stage--flash')
      } else {
        // Create SWF execution button (existing behavior)
        mediaElement = createSwfExecutionButton({
          postId: props.post.id,
          label: 'Click to Play Flash',
          icon: '⚡',
          onClick: () => props.onModeChange(PostCardMode.EXECUTING)
        })
        // Add flash class for 4:3 aspect ratio
        container.classList.add('post-stage--flash')
      }
    } else if (props.post.gif_key && props.post.gif_key.startsWith('audio/')) {
      mediaElement = createAudioPlayer({
        gifKey: props.post.gif_key,
        postId: props.post.id
      })
    } else {
      mediaElement = createImagePreview({
        gifKey: props.post.gif_key,
        postId: props.post.id
      })
    }
    
    container.appendChild(mediaElement)
    
    // Add click hint only for executable content (not images or audio)
    if (!props.post.payload_key?.startsWith('zip/') && !props.post.swf_key?.startsWith('swf/') && !props.post.gif_key) {
      const hint = document.createElement('div')
      hint.className = 'stage-hint'
      hint.textContent = 'Click to run'
      container.appendChild(hint)
    }
  } else {
    // For ZIP files, use the new ZIP execution engine
    if (props.post.payload_key && props.post.payload_key.startsWith('zip/')) {
      // The executeZipAuto function will handle creating the iframe and cleanup
      executeZipAuto(props.post.id, container).catch((error: Error) => {
        console.error('Failed to execute ZIP:', error)
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Failed to load ZIP content</div>'
      })
    } else if (props.post.swf_key && props.post.swf_key.startsWith('swf/')) {
      // Execute Flash/SWF content using Ruffle
      executeFlash(props.post.id, container).catch(error => {
        console.error('Failed to execute SWF:', error)
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Failed to load Flash content</div>'
      })
    } else {
      // For non-ZIP files, use the old sandbox frame
      const { createSandboxFrame } = await import('./SandboxFrame.js')
      const sandboxFrame = createSandboxFrame({
        postId: props.post.id,
        sandboxOrigin: props.sandboxOrigin
      })
      container.appendChild(sandboxFrame)
    }
  }
}

// Export a function to update the stage content when mode changes
export function updatePostStage(container: HTMLElement, props: PostStageProps): void {
  updateStageContent(container, props).catch(error => {
    console.error('Error updating stage content:', error)
  })
}
