import { Post } from '../types/post.js'
import { createPostCard } from './PostCard.js'

export interface CurrentUser {
  username: string
  id: string
  display_name?: string
  avatar_key?: string
}

export function createUserPostList(props: {
  username: string
  sandboxOrigin: string
  currentUser: CurrentUser | null
}): { getElement: () => HTMLElement; destroy: () => void } {
  // State
  let posts: Post[] = []
  let cursor: string | undefined
  let hasMore = true
  let loading = false
  let postCards: Map<string, ReturnType<typeof createPostCard>> = new Map()
  let intersectionObserver: IntersectionObserver | null = null
  let loadMoreSentinel: HTMLElement | null = null

  // Create main container
  const container = document.createElement('div')
  container.className = 'user-post-list'

  // Create post list
  const postList = document.createElement('div')
  postList.className = 'post-list'
  container.appendChild(postList)

  // Create load more section
  const loadMoreContainer = document.createElement('div')
  loadMoreContainer.className = 'load-more-container'

  // Create sentinel element for intersection observer
  loadMoreSentinel = document.createElement('div')
  loadMoreSentinel.className = 'load-more-sentinel'
  loadMoreSentinel.style.height = '100px'
  loadMoreSentinel.style.width = '100%'

  // Add loading spinner (hidden by default)
  const loadingSpinner = document.createElement('div')
  loadingSpinner.className = 'loading-spinner'
  const spinner = document.createElement('div')
  spinner.className = 'spinner'
  const spinnerLabel = document.createElement('span')
  spinnerLabel.textContent = 'Loading...'
  loadingSpinner.appendChild(spinner)
  loadingSpinner.appendChild(spinnerLabel)
  loadingSpinner.style.display = 'none'
  loadingSpinner.style.textAlign = 'center'
  loadingSpinner.style.padding = '1rem'

  loadMoreContainer.appendChild(loadMoreSentinel)
  loadMoreContainer.appendChild(loadingSpinner)
  container.appendChild(loadMoreContainer)

  // Render posts
  const renderPosts = () => {
    postList.innerHTML = ''

    if (posts.length === 0 && !loading) {
      const emptyState = document.createElement('p')
      emptyState.className = 'font-mono'
      postList.appendChild(emptyState)
      return
    }

    posts.forEach(post => {
      const postCard = createPostCard({
        post,
        sandboxOrigin: props.sandboxOrigin,
        currentUser: props.currentUser,
        depth: post.depth,
        onDelete: (postId) => {
          // Remove post from local state
          posts = posts.filter(p => p.id !== postId)
          postCards.delete(postId)
          renderPosts()
        }
      })
      
      postCards.set(post.id, postCard)
      postList.appendChild(postCard.getElement())
    })
  }

  // Setup intersection observer for infinite scroll
  const setupIntersectionObserver = () => {
    if (!loadMoreSentinel) return

    // Disconnect existing observer if any
    if (intersectionObserver) {
      intersectionObserver.disconnect()
    }

    // Create new intersection observer optimized for mobile
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && !loading && hasMore) {
          loadMorePosts()
        }
      },
      {
        root: null, // Use viewport as root
        rootMargin: '300px', // Start loading 300px before sentinel comes into view (better for mobile)
        threshold: 0.1 // Trigger when 10% is visible (more reliable than 0.1)
      }
    )

    // Start observing the sentinel
    intersectionObserver.observe(loadMoreSentinel)
  }

  // Update loading spinner visibility
  const updateLoadingSpinner = () => {
    if (loading) {
      loadingSpinner.style.display = 'block'
    } else {
      loadingSpinner.style.display = 'none'
    }

    // Hide sentinel when no more posts
    if (loadMoreSentinel) {
      loadMoreSentinel.style.display = hasMore ? 'block' : 'none'
    }
  }

  // Load initial posts
  const loadInitialPosts = async () => {
    if (loading) return
    
    loading = true
    updateLoadingSpinner()

    try {
      const params = new URLSearchParams()
      params.set('username', props.username)
      params.set('limit', '20')
      
      const response = await fetch(`/api/posts?${params.toString()}`, {
        credentials: 'include'
      })

      if (!response.ok) {
        throw new Error('Failed to fetch posts')
      }

      const data = await response.json() as { posts: Post[] }
      posts = data.posts
      
      if (data.posts.length > 0) {
        cursor = data.posts[data.posts.length - 1].created_at
      }
      
      hasMore = data.posts.length === 20
      renderPosts()

    } catch (error) {
      console.error('Failed to load posts:', error)
    } finally {
      loading = false
      updateLoadingSpinner()
    }
  }

  // Load more posts
  const loadMorePosts = async () => {
    if (loading || !hasMore || !cursor) return

    loading = true
    updateLoadingSpinner()

    try {
      const params = new URLSearchParams()
      params.set('username', props.username)
      params.set('limit', '20')
      params.set('cursor', cursor)
      
      const response = await fetch(`/api/posts?${params.toString()}`, {
        credentials: 'include'
      })

      if (!response.ok) {
        throw new Error('Failed to fetch more posts')
      }

      const data = await response.json() as { posts: Post[] }
      posts = [...posts, ...data.posts]
      
      if (data.posts.length > 0) {
        cursor = data.posts[data.posts.length - 1].created_at
      }
      
      hasMore = data.posts.length === 20
      renderPosts()

    } catch (error) {
      console.error('Failed to load more posts:', error)
    } finally {
      loading = false
      updateLoadingSpinner()
    }
  }

  // Setup intersection observer and load initial posts
  setupIntersectionObserver()
  loadInitialPosts()

  return {
    getElement: () => container,
    destroy: () => {
      // Clean up intersection observer
      if (intersectionObserver) {
        intersectionObserver.disconnect()
        intersectionObserver = null
      }
      
      postCards.forEach(card => card.destroy())
      postCards.clear()
      container.remove()
    }
  }
}
