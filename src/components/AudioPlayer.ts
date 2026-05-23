import { GifPreviewProps } from '../types/post.js'
import { AudioVisualizer } from './AudioVisualizer.js'
import { t } from '../lib/i18n.js'

export function createAudioPlayer(props: GifPreviewProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'audio-player'
  
  if (!props.gifKey) {
    // Fallback for posts without audio
    const fallback = document.createElement('div')
    fallback.className = 'audio-player-error'
    fallback.textContent = t('audio.no_audio')
    container.appendChild(fallback)
    return container
  }
  
  // Add loading indicator
  const loading = document.createElement('div')
  loading.className = 'audio-player-loading'
  loading.textContent = t('audio.loading')
  container.appendChild(loading)
  
  // Create visualizer canvas
  const visualizerCanvas = document.createElement('canvas')
  visualizerCanvas.className = 'audio-visualizer-canvas'
  visualizerCanvas.width = 400
  visualizerCanvas.height = 120
  container.appendChild(visualizerCanvas)
  
  const audio = document.createElement('audio')
  audio.className = 'audio-player-element'
  audio.controls = true
  audio.preload = 'metadata'
  audio.setAttribute('playsinline', 'true')
  audio.muted = false
  audio.style.display = 'block'
  audio.style.visibility = 'visible'
  audio.style.opacity = '1'
  audio.style.width = '100%'
  audio.style.height = 'auto'
  audio.style.minHeight = '54px'
  
  // Use the API proxy endpoint for audio
  const audioUrl = `/api/audio/${props.gifKey}`
  
  // Initialize visualizer after audio element is ready
  let visualizer: AudioVisualizer | null = null
  
  // Force Chrome to load the audio element properly
  setTimeout(() => {
    audio.src = audioUrl
    audio.load() // Explicitly call load() for Chrome
    
    // Initialize visualizer after audio source is set
    if (audio.src) {
      try {
        visualizer = new AudioVisualizer(audio, visualizerCanvas)
      } catch (error) {
        console.warn('Failed to initialize audio visualizer:', error)
      }
    }
  }, 100)
  
  // Handle audio load success
  audio.onloadstart = () => {
    loading.style.display = 'none'
  }
  
  // Handle audio canplay event - Chrome compatibility
  audio.oncanplay = () => {
    // Audio is ready to play
    console.log('Audio can play')
  }
  
  // Handle audio play attempt for Chrome autoplay policy
  audio.addEventListener('play', () => {
    console.log('Audio play started')
  })
  
  audio.addEventListener('pause', () => {
    console.log('Audio paused')
  })
  
  // Handle audio loading errors
  audio.onerror = (e) => {
    console.error('Audio error:', e)
    console.error('Audio error code:', audio.error?.code)
    console.error('Audio error message:', audio.error?.message)
    loading.style.display = 'none'
    audio.style.display = 'none'
    visualizerCanvas.style.display = 'none'
    const fallback = document.createElement('div')
    fallback.className = 'audio-player-error'
    fallback.textContent = t('audio.load_failed', { error: audio.error?.message || t('common.error') })
    container.appendChild(fallback)
  }
  
  // Handle network errors specifically
  audio.addEventListener('stalled', () => {
    console.warn('Audio stalled - network issue')
  })
  
  audio.addEventListener('suspend', () => {
    console.warn('Audio suspended - browser paused loading')
  })
  
  // Add click handler to ensure user interaction for Chrome autoplay policy
  container.addEventListener('click', () => {
    if (audio.paused && audio.readyState >= 2) { // HAVE_CURRENT_DATA
      audio.play().catch(error => {
        console.warn('Audio play failed:', error)
      })
    }
  }, { once: false })
  
  container.appendChild(audio)
  
  // Cleanup function for when the component is destroyed
  container.addEventListener('DOMNodeRemoved', () => {
    if (visualizer) {
      visualizer.cleanup()
      visualizer = null
    }
  })
  
  return container
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  // Check if the key is for an audio file
  if (props.gifKey && props.gifKey.startsWith('audio/')) {
    return createAudioPlayer(props)
  }
  
  // For image files, use the existing ImagePreview
  // This is a simplified version - in practice, you'd import and use createImagePreview
  const container = document.createElement('div')
  container.className = 'image-preview'
  
  if (!props.gifKey) {
    const fallback = document.createElement('div')
    fallback.className = 'image-preview-error'
    fallback.textContent = t('image_preview.no_preview')
    container.appendChild(fallback)
    return container
  }
  
  const img = document.createElement('img')
  img.className = 'image-preview-img'
  img.alt = t('image_preview.post_preview', { id: props.postId })
  img.loading = 'lazy'
  
  const imageUrl = `/api/images/${props.gifKey}`
  img.src = imageUrl
  
  img.onerror = () => {
    img.style.display = 'none'
    const fallback = document.createElement('div')
    fallback.className = 'image-preview-error'
    fallback.textContent = t('image_preview.load_failed')
    container.appendChild(fallback)
  }
  
  container.appendChild(img)
  return container
}
