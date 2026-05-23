import { t } from '../lib/i18n.js'

export interface AdminLayoutProps {
  activeTab: 'alerts' | 'hidden' | 'users' | 'ads'
  onTabChange: (tab: 'alerts' | 'hidden' | 'users' | 'ads') => void
}

export function createAdminLayout({ activeTab, onTabChange }: AdminLayoutProps) {
  let element: HTMLElement
  let mainContentContainer: HTMLElement

  const createElement = (): HTMLElement => {
    const container = document.createElement('div')
    container.className = 'admin-layout'
    container.style.cssText = `
      min-height: 100vh;
      background: #0f172a;
      color: #f1f5f9;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `

    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      border-bottom: 1px solid #1e293b;
    `

    const logo = document.createElement('div')
    logo.innerHTML = `<a href="/home" style="color: #22c55e; text-decoration: none; font-size: 20px; font-weight: 600;">${t('admin_layout.title')}</a>`
    header.appendChild(logo)

    const backLink = document.createElement('a')
    backLink.href = '/home'
    backLink.textContent = t('admin_layout.back')
    backLink.style.cssText = `
      color: #94a3b8;
      text-decoration: none;
      font-size: 14px;
      transition: color 0.2s;
    `
    backLink.addEventListener('mouseenter', () => backLink.style.color = '#f1f5f9')
    backLink.addEventListener('mouseleave', () => backLink.style.color = '#94a3b8')
    header.appendChild(backLink)

    container.appendChild(header)

    const body = document.createElement('div')
    body.style.cssText = 'display: flex; min-height: calc(100vh - 65px);'

    const sidebar = document.createElement('div')
    sidebar.style.cssText = `
      width: 200px;
      border-right: 1px solid #1e293b;
      padding: 16px 0;
    `

    const tabs: { id: 'alerts' | 'hidden' | 'users' | 'ads'; label: string }[] = [
      { id: 'alerts', label: t('admin_layout.tab_alerts') },
      { id: 'hidden', label: t('admin_layout.tab_hidden') },
      { id: 'users', label: t('admin_layout.tab_users') },
      { id: 'ads', label: t('admin_layout.tab_ads') }
    ]

    tabs.forEach(tab => {
      const tabBtn = document.createElement('button')
      tabBtn.textContent = tab.label
      tabBtn.style.cssText = `
        width: 100%;
        padding: 12px 24px;
        background: transparent;
        color: ${activeTab === tab.id ? '#22c55e' : '#94a3b8'};
        font-weight: ${activeTab === tab.id ? '600' : '400'};
        font-size: 14px;
        text-align: left;
        border: none;
        cursor: pointer;
        transition: all 0.2s;
      `
      tabBtn.addEventListener('click', () => {
        onTabChange(tab.id)
      })
      sidebar.appendChild(tabBtn)
    })

    body.appendChild(sidebar)

    mainContentContainer = document.createElement('div')
    mainContentContainer.style.cssText = 'flex: 1; padding: 24px; overflow-y: auto;'

    body.appendChild(mainContentContainer)
    container.appendChild(body)

    return container
  }

  const updateMainContent = (content: HTMLElement) => {
    mainContentContainer.innerHTML = ''
    mainContentContainer.appendChild(content)
  }

  const setAccessDenied = () => {
    mainContentContainer.innerHTML = ''
    const deniedMsg = document.createElement('div')
    deniedMsg.innerHTML = t('admin_layout.access_denied')
    deniedMsg.style.cssText = `
      color: #f1f5f9;
      font-size: 18px;
      text-align: center;
      padding: 48px;
    `
    mainContentContainer.appendChild(deniedMsg)
  }

  element = createElement()

  return {
    getElement: () => element,
    updateMainContent,
    setAccessDenied,
    destroy: () => {
      if (element.parentNode) {
        element.parentNode.removeChild(element)
      }
    }
  }
}
