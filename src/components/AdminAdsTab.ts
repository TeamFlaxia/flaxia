import { registerModal } from '../lib/modal-state.js'

export interface AdminAd {
  id: string
  title: string
  ad_type: 'self_hosted' | 'admax'
  body_text: string
  click_url: string | null
  payload_key: string | null
  payload_type: 'zip' | 'swf' | 'gif' | 'image' | null
  thumbnail_key?: string
  impressions: number
  clicks: number
  active: number
  created_at: string
  ctr?: number
  interaction_count?: number
}

export interface AdminAdsTabProps {
  onNavigateToTab: (tab: 'alerts' | 'hidden' | 'users' | 'ads') => void
}

export function createAdminAdsTab({ onNavigateToTab }: AdminAdsTabProps) {
  let element: HTMLElement
  let ads: AdminAd[] = []
  let everyN = 8
  let modalOpen = false
  let unregisterModalFn: (() => void) | null = null
  let editingAd: AdminAd | null = null

  // Create container immediately
  element = document.createElement('div')
  element.style.cssText = 'max-width: 1200px;'

  const fetchAds = async () => {
    try {
      const response = await fetch('/api/admin/ads', { credentials: 'include' })
      if (response.status === 403) {
        console.error('Admin access denied - check if user has admin privileges')
        alert('Admin access denied. You need admin privileges to manage ads.')
        return []
      }
      if (!response.ok) {
        const errorText = await response.text()
        console.error('Failed to fetch ads:', response.status, errorText)
        throw new Error(`Failed to fetch ads: ${response.status}`)
      }
      const data = await response.json()
      return (data as { ads: AdminAd[] }).ads || []
    } catch (error) {
      console.error('Fetch ads error:', error)
      alert(`Failed to load ads: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return []
    }
  }

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/admin/ads/config', { credentials: 'include' })
      if (response.status === 403) {
        console.error('Admin access denied for config - check if user has admin privileges')
        return 8
      }
      if (!response.ok) {
        const errorText = await response.text()
        console.error('Failed to fetch config:', response.status, errorText)
        throw new Error(`Failed to fetch config: ${response.status}`)
      }
      const data = await response.json()
      return (data as { every_n: number }).every_n || 8
    } catch (error) {
      console.error('Fetch config error:', error)
      return 8
    }
  }

  const updateAdActive = async (adId: string, active: boolean) => {
    try {
      const response = await fetch(`/api/admin/ads/${adId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: active ? 1 : 0 }),
        credentials: 'include'
      })
      if (!response.ok) {
        throw new Error('Failed to update ad')
      }
      return true
    } catch (error) {
      console.error('Update ad error:', error)
      return false
    }
  }

  const deleteAd = async (adId: string) => {
    try {
      const response = await fetch(`/api/admin/ads/${adId}`, {
        method: 'DELETE',
        credentials: 'include'
      })
      if (!response.ok) {
        throw new Error('Failed to delete ad')
      }
      return true
    } catch (error) {
      console.error('Delete ad error:', error)
      return false
    }
  }

  const saveConfig = async (newEveryN: number) => {
    try {
      const response = await fetch('/api/admin/ads/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ every_n: newEveryN }),
        credentials: 'include'
      })
      if (!response.ok) {
        throw new Error('Failed to save config')
      }
      return true
    } catch (error) {
      console.error('Save config error:', error)
      return false
    }
  }

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr)
    return date.toLocaleDateString()
  }

  const getFormatLabel = (payloadType: string | null, adType?: string): string => {
    if (adType === 'admax') return 'Admax'
    switch (payloadType) {
      case 'zip': return 'ZIP'
      case 'swf': return 'SWF'
      case 'gif': return 'GIF'
      case 'image': return 'Image'
      default: return '—'
    }
  }

  const createSettingsSection = () => {
    const section = document.createElement('div')
    section.style.cssText = `
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    `

    const title = document.createElement('h3')
    title.textContent = 'Global settings'
    title.style.cssText = `
      color: #f1f5f9;
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
    `
    section.appendChild(title)

    const form = document.createElement('div')
    form.style.cssText = 'display: flex; align-items: center; gap: 12px;'

    const label = document.createElement('label')
    label.textContent = 'every_n:'
    label.style.cssText = 'color: #94a3b8; font-size: 14px;'
    form.appendChild(label)

    const input = document.createElement('input')
    input.type = 'number'
    input.min = '1'
    input.value = everyN.toString()
    input.style.cssText = `
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 14px;
      width: 80px;
    `

    const saveBtn = document.createElement('button')
    saveBtn.textContent = 'Save'
    saveBtn.style.cssText = `
      background: #22c55e;
      color: #f1f5f9;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    `
    saveBtn.addEventListener('click', async () => {
      const newEveryN = parseInt(input.value)
      if (newEveryN >= 1) {
        const success = await saveConfig(newEveryN)
        if (success) {
          everyN = newEveryN
          showMessage('Settings saved successfully', 'success')
        } else {
          showMessage('Failed to save settings', 'error')
        }
      } else {
        showMessage('every_n must be at least 1', 'error')
      }
    })

    form.appendChild(input)
    form.appendChild(saveBtn)
    section.appendChild(form)

    const messageDiv = document.createElement('div')
    messageDiv.id = 'config-message'
    messageDiv.style.cssText = `
      margin-top: 12px;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 14px;
      display: none;
    `
    section.appendChild(messageDiv)

    const showMessage = (text: string, type: 'success' | 'error') => {
      messageDiv.textContent = text
      messageDiv.style.display = 'block'
      messageDiv.style.background = type === 'success' ? '#065f46' : '#dc2626'
      messageDiv.style.color = '#f1f5f9'
      setTimeout(() => {
        messageDiv.style.display = 'none'
      }, 3000)
    }

    return section
  }

  const createAdsTable = () => {
    const section = document.createElement('div')
    section.style.cssText = 'margin-bottom: 24px;'

    const title = document.createElement('h3')
    title.textContent = 'Ad list'
    title.style.cssText = `
      color: #f1f5f9;
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    `
    section.appendChild(title)

    const newAdBtn = document.createElement('button')
    newAdBtn.textContent = '+ New Ad'
    newAdBtn.style.cssText = `
      background: #22c55e;
      color: #f1f5f9;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    `
    newAdBtn.addEventListener('click', () => {
      editingAd = null
      modalOpen = true
      render()
    })

    title.appendChild(newAdBtn)

    if (ads.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No ads created yet'
      empty.style.cssText = 'color: #64748b; font-size: 14px; padding: 24px; text-align: center; background: #1e293b; border-radius: 8px;'
      section.appendChild(empty)
      return section
    }

    const table = document.createElement('div')
    table.style.cssText = `
      background: #1e293b;
      border-radius: 8px;
      overflow: hidden;
    `

    // Header
    const header = document.createElement('div')
    header.style.cssText = `
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 80px 100px 100px 80px 120px 120px 80px;
      gap: 1px;
      background: #0f172a;
      padding: 12px 16px;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 0.875rem;
      color: var(--text-muted);
    `
    header.innerHTML = `
      <div>Title</div>
      <div>Type</div>
      <div>Format</div>
      <div>Active</div>
      <div>Impressions</div>
      <div>Clicks</div>
      <div>CTR</div>
      <div>Plays</div>
      <div>Age</div>
      <div>Actions</div>
    `
    table.appendChild(header)

    // Rows
    ads.forEach(ad => {
      const row = document.createElement('div')
      row.style.cssText = `
        display: grid;
        grid-template-columns: 2fr 1fr 1fr 80px 100px 100px 80px 120px 120px 80px;
        gap: 1px;
        background: #1e293b;
        padding: 12px 16px;
        font-size: 14px;
        align-items: center;
      `

      const title = document.createElement('div')
      title.textContent = ad.title
      title.style.cssText = 'color: #f1f5f9; font-weight: 500; overflow: hidden; text-overflow: ellipsis;'
      title.title = ad.title
      row.appendChild(title)

      // Ad Type column
      const adType = document.createElement('div')
      if (ad.ad_type === 'admax') {
        adType.textContent = 'Admax'
        adType.style.cssText = 'color: #8b5cf6; font-weight: 500;'
      } else {
        adType.textContent = 'Self'
        adType.style.cssText = 'color: #22c55e; font-weight: 500;'
      }
      row.appendChild(adType)

      const format = document.createElement('div')
      format.textContent = getFormatLabel(ad.payload_type, ad.ad_type)
      format.style.cssText = 'color: #94a3b8;'
      row.appendChild(format)

      const active = document.createElement('button')
      active.textContent = ad.active ? '✓' : '✗'
      active.style.cssText = `
        background: ${ad.active ? '#065f46' : '#dc2626'};
        color: #f1f5f9;
        border: none;
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: background 0.2s;
      `
      active.addEventListener('click', async () => {
        const newActive = !ad.active
        const success = await updateAdActive(ad.id, newActive)
        if (success) {
          ad.active = newActive ? 1 : 0
          active.textContent = newActive ? '✓' : '✗'
          active.style.background = newActive ? '#065f46' : '#dc2626'
        }
      })
      row.appendChild(active)

      const impressions = document.createElement('div')
      impressions.textContent = ad.impressions.toString()
      impressions.style.cssText = 'color: #94a3b8;'
      row.appendChild(impressions)

      const clicks = document.createElement('div')
      clicks.textContent = ad.clicks.toString()
      clicks.style.cssText = 'color: #94a3b8;'
      row.appendChild(clicks)

      const ctr = document.createElement('div')
      const ctrValue = ad.impressions > 0 ? ((ad.clicks / ad.impressions) * 100).toFixed(2) : '—'
      ctr.textContent = ad.impressions > 0 ? `${ctrValue}%` : '—'
      ctr.style.cssText = 'color: #94a3b8;'
      row.appendChild(ctr)

      // Plays/Interactions column for ZIP/SWF
      const interactions = document.createElement('div')
      if (ad.payload_type === 'zip' || ad.payload_type === 'swf') {
        const playCount = ad.interaction_count || 0
        const playCountEl = document.createElement('div')
        playCountEl.style.cssText = 'color: #f1f5f9; font-size: 12px;'
        playCountEl.textContent = `${playCount} plays`
        interactions.appendChild(playCountEl)
      } else {
        interactions.textContent = '—'
        interactions.style.cssText = 'color: #94a3b8;'
      }
      row.appendChild(interactions)

      // Age column
      const age = document.createElement('div')
      const createdDate = new Date(ad.created_at)
      const now = new Date()
      
      // Calculate days difference more accurately (accounting for timezone)
      const createdUTC = Date.UTC(createdDate.getFullYear(), createdDate.getMonth(), createdDate.getDate())
      const nowUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
      const daysDiff = Math.floor((nowUTC - createdUTC) / (1000 * 60 * 60 * 24))
      
      age.textContent = `${daysDiff}d`
      age.style.cssText = 'color: #94a3b8; font-size: 12px;'
      row.appendChild(age)

      const actions = document.createElement('div')
      actions.style.cssText = 'display: flex; gap: 8px;'

      const editBtn = document.createElement('button')
      editBtn.textContent = 'Edit'
      editBtn.style.cssText = `
        background: #334155;
        color: #f1f5f9;
        border: none;
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: background 0.2s;
      `
      editBtn.addEventListener('click', () => {
        editingAd = ad
        modalOpen = true
        render()
      })
      actions.appendChild(editBtn)

      const deleteBtn = document.createElement('button')
      deleteBtn.textContent = 'Delete'
      deleteBtn.style.cssText = `
        background: #dc2626;
        color: #f1f5f9;
        border: none;
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: background 0.2s;
      `
      deleteBtn.addEventListener('click', async () => {
        if (confirm(`Delete ad "${ad.title}"? This cannot be undone.`)) {
          const success = await deleteAd(ad.id)
          if (success) {
            ads = ads.filter(a => a.id !== ad.id)
            render()
          }
        }
      })
      actions.appendChild(deleteBtn)

      row.appendChild(actions)
      table.appendChild(row)
    })

    section.appendChild(table)
    return section
  }

  const createModal = () => {
    unregisterModalFn = registerModal()
    const modal = document.createElement('div')
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `

    const content = document.createElement('div')
    content.style.cssText = `
      background: #1e293b;
      border-radius: 8px;
      padding: 24px;
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    `

    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    `

    const title = document.createElement('h3')
    title.textContent = editingAd ? 'Edit Ad' : 'Create New Ad'
    title.style.cssText = `
      color: #f1f5f9;
      font-size: 20px;
      font-weight: 600;
      margin: 0;
    `

    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText = `
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
    `
    closeBtn.addEventListener('click', () => {
      unregisterModalFn?.()
      unregisterModalFn = null
      modalOpen = false
      editingAd = null
      render()
    })

    header.appendChild(title)
    header.appendChild(closeBtn)
    content.appendChild(header)

    const form = document.createElement('div')
    form.style.cssText = 'display: flex; flex-direction: column; gap: 16px;'

    // Ad Type field
    const adTypeField = document.createElement('div')
    adTypeField.style.cssText = 'display: flex; flex-direction: column; gap: 8px;'

    const adTypeLabel = document.createElement('label')
    adTypeLabel.textContent = 'Ad Type'
    adTypeLabel.style.cssText = 'color: #f1f5f9; font-size: 14px; font-weight: 500;'
    adTypeField.appendChild(adTypeLabel)

    const adTypeSelect = document.createElement('select')
    adTypeSelect.style.cssText = `
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 12px;
      border-radius: 4px;
      font-size: 14px;
    `
    
    const selfHostedOption = document.createElement('option')
    selfHostedOption.value = 'self_hosted'
    selfHostedOption.textContent = 'Self-hosted (ZIP/SWF/GIF/Image)'
    
    const admaxOption = document.createElement('option')
    admaxOption.value = 'admax'
    admaxOption.textContent = 'Admax (JavaScript ads)'
    
    adTypeSelect.appendChild(selfHostedOption)
    adTypeSelect.appendChild(admaxOption)
    
    if (editingAd?.ad_type) {
      adTypeSelect.value = editingAd.ad_type
    }
    
    adTypeField.appendChild(adTypeSelect)
    form.appendChild(adTypeField)

    // Title field
    const titleField = document.createElement('div')
    titleField.style.cssText = 'display: flex; flex-direction: column; gap: 8px;'

    const titleLabel = document.createElement('label')
    titleLabel.textContent = 'Title'
    titleLabel.style.cssText = 'color: #f1f5f9; font-size: 14px; font-weight: 500;'
    titleField.appendChild(titleLabel)

    const titleInput = document.createElement('input')
    titleInput.type = 'text'
    titleInput.value = editingAd?.title || ''
    titleInput.required = true
    titleInput.style.cssText = `
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 12px;
      border-radius: 4px;
      font-size: 14px;
    `

    const titleCounter = document.createElement('span')
    titleCounter.style.cssText = 'color: #64748b; font-size: 12px; margin-top: 4px;'
    titleCounter.textContent = `${titleInput.value.length}/200`

    titleInput.addEventListener('input', () => {
      titleCounter.textContent = `${titleInput.value.length}/200`
    })

    titleField.appendChild(titleInput)
    titleField.appendChild(titleCounter)
    form.appendChild(titleField)

    // Body text field
    const bodyField = document.createElement('div')
    bodyField.style.cssText = 'display: flex; flex-direction: column; gap: 8px;'

    const bodyLabel = document.createElement('label')
    bodyLabel.textContent = 'Body text'
    bodyLabel.style.cssText = 'color: #f1f5f9; font-size: 14px; font-weight: 500;'
    bodyField.appendChild(bodyLabel)

    const bodyTextarea = document.createElement('textarea')
    bodyTextarea.value = editingAd?.body_text || ''
    bodyTextarea.maxLength = 200
    bodyTextarea.rows = 4
    bodyTextarea.style.cssText = `
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 12px;
      border-radius: 4px;
      font-size: 14px;
      resize: vertical;
      font-family: inherit;
    `

    const bodyCounter = document.createElement('span')
    bodyCounter.style.cssText = 'color: #64748b; font-size: 12px; margin-top: 4px;'
    bodyCounter.textContent = `${bodyTextarea.value.length}/200`

    bodyTextarea.addEventListener('input', () => {
      bodyCounter.textContent = `${bodyTextarea.value.length}/200`
    })

    bodyField.appendChild(bodyTextarea)
    bodyField.appendChild(bodyCounter)
    form.appendChild(bodyField)

    // Click URL field
    const urlField = document.createElement('div')
    urlField.style.cssText = 'display: flex; flex-direction: column; gap: 8px;'

    const urlLabel = document.createElement('label')
    urlLabel.textContent = 'Click URL (optional)'
    urlLabel.style.cssText = 'color: #f1f5f9; font-size: 14px; font-weight: 500;'
    urlField.appendChild(urlLabel)

    const urlInput = document.createElement('input')
    urlInput.type = 'url'
    urlInput.value = editingAd?.click_url || ''
    urlInput.placeholder = 'https://example.com'
    urlInput.style.cssText = `
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 12px;
      border-radius: 4px;
      font-size: 14px;
    `

    urlField.appendChild(urlInput)
    form.appendChild(urlField)


    // Payload field
    const payloadField = document.createElement('div')
    payloadField.style.cssText = 'display: flex; flex-direction: column; gap: 8px;'

    const payloadLabel = document.createElement('label')
    payloadLabel.textContent = 'Payload (optional)'
    payloadLabel.style.cssText = 'color: #f1f5f9; font-size: 14px; font-weight: 500;'
    payloadField.appendChild(payloadLabel)

    const payloadInput = document.createElement('input')
    payloadInput.type = 'file'
    payloadInput.accept = '.zip,.swf,.gif,.png,.jpg,.jpeg'
    payloadInput.style.cssText = `
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 8px;
      border-radius: 4px;
      font-size: 14px;
    `

    if (editingAd?.payload_key) {
      const currentFile = document.createElement('div')
      currentFile.textContent = `Current file: ${editingAd.payload_key}`
      currentFile.style.cssText = 'color: #64748b; font-size: 12px; margin-top: 4px;'
      payloadField.appendChild(currentFile)
    }

    payloadField.appendChild(payloadInput)
    form.appendChild(payloadField)

    // Thumbnail field
    const thumbnailField = document.createElement('div')
    thumbnailField.style.cssText = 'display: flex; flex-direction: column; gap: 8px;'

    const thumbnailLabel = document.createElement('label')
    thumbnailLabel.textContent = 'Thumbnail (optional, for ZIP/SWF ads)'
    thumbnailLabel.style.cssText = 'color: #f1f5f9; font-size: 14px; font-weight: 500;'
    thumbnailField.appendChild(thumbnailLabel)

    const thumbnailInput = document.createElement('input')
    thumbnailInput.type = 'file'
    thumbnailInput.accept = '.jpg,.jpeg,.png,.gif'
    thumbnailInput.style.cssText = `
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 8px;
      border-radius: 4px;
      font-size: 14px;
    `

    const thumbnailHint = document.createElement('div')
    thumbnailHint.textContent = 'accepts .jpg .png .gif, max 1MB'
    thumbnailHint.style.cssText = 'color: #64748b; font-size: 12px; margin-top: 4px;'

    if (editingAd?.thumbnail_key) {
      const currentThumbnail = document.createElement('div')
      currentThumbnail.textContent = `Current thumbnail: ${editingAd.thumbnail_key}`
      currentThumbnail.style.cssText = 'color: #64748b; font-size: 12px; margin-bottom: 4px;'
      thumbnailField.appendChild(currentThumbnail)
    }

    thumbnailField.appendChild(thumbnailInput)
    thumbnailField.appendChild(thumbnailHint)
    form.appendChild(thumbnailField)

    // Function to toggle field visibility based on ad type (now defined after all fields)
    const toggleFieldVisibility = () => {
      const isAdmax = adTypeSelect.value === 'admax'
      payloadField.style.display = isAdmax ? 'none' : 'flex'
      thumbnailField.style.display = isAdmax ? 'none' : 'flex'
    }

    // Add event listener to ad type selector
    adTypeSelect.addEventListener('change', toggleFieldVisibility)
    
    // Set initial visibility
    toggleFieldVisibility()

    // Stats row for edit mode
    if (editingAd) {
      const statsRow = document.createElement('div')
      statsRow.style.cssText = `
        background: #0f172a;
        border-radius: 4px;
        padding: 12px;
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 16px;
        font-size: 13px;
        color: #94a3b8;
      `
      
      let statsHTML = `
        <div>Impressions: <strong style="color: #f1f5f9;">${editingAd.impressions}</strong></div>
        <div>Clicks: <strong style="color: #f1f5f9;">${editingAd.clicks}</strong></div>
        <div>CTR: <strong style="color: #f1f5f9;">${editingAd.impressions > 0 ? ((editingAd.clicks / editingAd.impressions) * 100).toFixed(2) : '—'}%</strong></div>
      `
      
      if (editingAd.payload_type === 'zip' || editingAd.payload_type === 'swf') {
        const playCount = editingAd.interaction_count || 0
        statsHTML += `<div>Plays: <strong style="color: #f1f5f9;">${playCount}</strong></div>`
      } else {
        statsHTML += `<div>Type: <strong style="color: #f1f5f9;">${getFormatLabel(editingAd.payload_type)}</strong></div>`
      }
      
      statsRow.innerHTML = statsHTML
      form.appendChild(statsRow)
    }

    content.appendChild(form)

    // Submit button
    const submitBtn = document.createElement('button')
    submitBtn.textContent = editingAd ? 'Update Ad' : 'Create Ad'
    submitBtn.style.cssText = `
      background: #22c55e;
      color: #f1f5f9;
      border: none;
      padding: 12px 24px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      margin-top: 8px;
      transition: background 0.2s;
    `
    submitBtn.addEventListener('click', async () => {
      const title = titleInput.value.trim()
      const bodyText = bodyTextarea.value.trim()
      const clickUrl = urlInput.value.trim() || null
      const adType = adTypeSelect.value as 'self_hosted' | 'admax'

      if (!title || !bodyText) {
        alert('Title and body text are required')
        return
      }

      // Validate admax ads (no payload files allowed)
      if (adType === 'admax' && payloadInput.files?.[0]) {
        alert('Admax ads do not support payload files')
        return
      }

      // Validate file sizes client-side (100MB limit for Cloudflare Free/Pro)
      const maxFileSize = 100 * 1024 * 1024 // 100MB
      if (payloadInput.files?.[0] && payloadInput.files[0].size > maxFileSize) {
        const fileSizeMB = (payloadInput.files[0].size / 1024 / 1024).toFixed(1)
        alert(`File too large: ${fileSizeMB}MB. Maximum allowed: 100MB.\n\nFor larger files, upgrade to Cloudflare Business plan (200MB limit).`)
        return
      }

      if (thumbnailInput.files?.[0] && thumbnailInput.files[0].size > 1024 * 1024) {
        alert(`Thumbnail too large: ${(thumbnailInput.files[0].size / 1024 / 1024).toFixed(1)}MB. Maximum allowed: 1MB.`)
        return
      }

      try {
        if (editingAd) {
          // Update existing ad
          const response = await fetch(`/api/admin/ads/${editingAd.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              title, 
              body_text: bodyText, 
              click_url: clickUrl,
              ad_type: adType
            }),
          })
          if (!response.ok) {
            throw new Error('Failed to update ad')
          }
        } else {
          // Create new ad
          const formData = new FormData()
          formData.append('title', title)
          formData.append('body_text', bodyText)
          formData.append('ad_type', adType)
          if (clickUrl) {
            formData.append('click_url', clickUrl)
          }
          if (payloadInput.files?.[0]) {
            formData.append('payload', payloadInput.files[0])
          }
          if (thumbnailInput.files?.[0]) {
            formData.append('thumbnail', thumbnailInput.files[0])
          }

          const response = await fetch('/api/admin/ads', {
            method: 'POST',
            body: formData,
            credentials: 'include'
          })
          
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({})) as { error?: string }
            throw new Error(errorData.error || `Failed to create ad (${response.status})`)
          }
        }

        modalOpen = false
        editingAd = null
        await refreshAds()
        render()
      } catch (error: any) {
        console.error('Submit ad error:', error)
        
        // Show detailed error message for file size issues
        if (error.error && error.limit && error.actualSize) {
          const actualMB = (error.actualSize / 1024 / 1024).toFixed(1)
          const limitMB = (error.limit / 1024 / 1024).toFixed(1)
          alert(`File too large: ${actualMB}MB. Maximum allowed: ${limitMB}MB.\n\n${error.error}`)
        } else {
          alert(`Failed to save ad: ${error?.error || error?.message || 'Unknown error'}`)
        }
      }
    })

    content.appendChild(submitBtn)
    modal.appendChild(content)

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        unregisterModalFn?.()
        unregisterModalFn = null
        modalOpen = false
        editingAd = null
        render()
      }
    })

    return modal
  }

  const refreshAds = async () => {
    ads = await fetchAds() || []
  }

  const render = async () => {
    element.innerHTML = ''

    // Settings section
    element.appendChild(createSettingsSection())

    // Ads table
    element.appendChild(createAdsTable())

    // Modal
    if (modalOpen) {
      element.appendChild(createModal())
    }
  }

  const init = async () => {
    everyN = await fetchConfig()
    await refreshAds()
    await render()
  }

  // Start initialization but don't wait for it
  init()

  return {
    getElement: () => element,
    refresh: async () => {
      await refreshAds()
      await render()
    },
    destroy: () => {
      if (element && element.parentNode) {
        element.parentNode.removeChild(element)
      }
    }
  }
}
