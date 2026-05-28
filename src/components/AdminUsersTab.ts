import { t } from '../lib/i18n.js'
import { formatCount } from '../lib/format.js'
import { createConfirmDialog } from '../lib/confirm-dialog.js'

export interface AdminUser {
  id: string
  username: string
  display_name: string
  email: string
  created_at: string
}

export interface AdminUsersTabProps {
  onNavigateToTab: (tab: 'alerts' | 'hidden' | 'users' | 'ads') => void
  adminUsernames?: string[]
}

export function createAdminUsersTab({ onNavigateToTab, adminUsernames = [] }: AdminUsersTabProps) {
  let element: HTMLElement
  let users: AdminUser[] = []
  let filteredUsers: AdminUser[] = []
  let searchQuery = ''

  // Create container immediately
  element = document.createElement('div')
  element.style.cssText = 'max-width: 900px;'

  const fetchUsers = async () => {
    try {
      const response = await fetch('/api/admin/users', { credentials: 'include' })
      if (response.status === 403) {
        return null
      }
      if (!response.ok) {
        throw new Error('Failed to fetch users')
      }
      const data = await response.json()
      return data.users as AdminUser[]
    } catch (error) {
      console.error('Fetch users error:', error)
      return []
    }
  }

  const deleteUser = async (userId: string) => {
    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        credentials: 'include'
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete user')
      }
      return true
    } catch (error) {
      console.error('Delete user error:', error)
      return false
    }
  }

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr)
    return date.toLocaleDateString()
  }

  const filterUsers = () => {
    if (!searchQuery.trim()) {
      filteredUsers = [...users]
    } else {
      const query = searchQuery.toLowerCase()
      filteredUsers = users.filter(user =>
        user.username.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query)
      )
    }
  }

  const createUserRow = (user: AdminUser) => {
    const row = document.createElement('div')
    row.style.cssText = `
      display: flex;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid #1e293b;
      gap: 12px;
      flex-wrap: wrap;
    `

    const username = document.createElement('span')
    username.style.cssText = 'color: #22c55e; font-size: 14px; font-weight: 500; min-width: 150px;'
    username.textContent = `@${user.username}`
    row.appendChild(username)

    const displayName = document.createElement('span')
    displayName.style.cssText = 'color: #f1f5f9; font-size: 14px; min-width: 120px;'
    displayName.textContent = user.display_name
    row.appendChild(displayName)

    const email = document.createElement('span')
    email.style.cssText = 'color: #94a3b8; font-size: 14px; min-width: 200px; overflow: hidden; text-overflow: ellipsis;'
    email.textContent = user.email
    email.title = user.email
    row.appendChild(email)

    const joined = document.createElement('span')
    joined.style.cssText = 'color: #64748b; font-size: 13px; margin-left: auto;'
    joined.textContent = formatDate(user.created_at)
    row.appendChild(joined)

    const isAdmin = adminUsernames.includes(user.username)
    if (!isAdmin) {
      const deleteBtn = document.createElement('button')
      deleteBtn.textContent = t('admin_users.delete_account')
      deleteBtn.style.cssText = `
        background: #334155;
        color: #f1f5f9;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: background 0.2s;
      `
      deleteBtn.addEventListener('click', async () => {
        const confirmed = await createConfirmDialog(t('admin_users.delete_confirm', { username: user.username }))
        if (!confirmed) return
        const success = await deleteUser(user.id)
        if (success) {
          users = users.filter(u => u.id !== user.id)
          filterUsers()
          render()
        }
      })
      row.appendChild(deleteBtn)
    } else {
      const adminBadge = document.createElement('span')
      adminBadge.textContent = t('admin_users.admin_badge')
      adminBadge.style.cssText = `
        background: #22c55e20;
        color: #22c55e;
        border: 1px solid #22c55e40;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
      `
      row.appendChild(adminBadge)
    }

    return row
  }

  const render = async () => {
    element.innerHTML = ''

    const title = document.createElement('h2')
    title.textContent = t('admin_users.title')
    title.style.cssText = `
      color: #f1f5f9;
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 16px;
    `
    element.appendChild(title)

    // Add user count display
    const countContainer = document.createElement('div')
    countContainer.style.cssText = `
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    `

    const totalCount = document.createElement('div')
    totalCount.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 16px;
      color: #f1f5f9;
    `

    const countLabel = document.createElement('span')
    countLabel.textContent = t('admin_users.total_users')
    countLabel.style.cssText = 'color: #94a3b8; font-weight: 500;'

    const countNumber = document.createElement('span')
    countNumber.textContent = formatCount(users.length)
    countNumber.style.cssText = `
      color: #22c55e;
      font-weight: 600;
      font-size: 18px;
    `

    totalCount.appendChild(countLabel)
    totalCount.appendChild(countNumber)
    countContainer.appendChild(totalCount)
    element.appendChild(countContainer)

    const searchContainer = document.createElement('div')
    searchContainer.style.cssText = 'margin-bottom: 16px;'

    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.placeholder = t('admin_users.search_placeholder')
    searchInput.style.cssText = `
      width: 100%;
      max-width: 300px;
      padding: 10px 14px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      color: #f1f5f9;
      font-size: 14px;
    `
    searchInput.addEventListener('input', (e) => {
      searchQuery = (e.target as HTMLInputElement).value
      filterUsers()
      renderUsersList()
    })
    searchContainer.appendChild(searchInput)
    element.appendChild(searchContainer)

    const tableHeader = document.createElement('div')
    tableHeader.style.cssText = `
      display: flex;
      align-items: center;
      padding: 12px 16px;
      background: #0f172a;
      border-radius: 8px 8px 0 0;
      gap: 12px;
      font-size: 12px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    `
    tableHeader.innerHTML = `
      <span style="min-width: 150px;">${t('admin_users.header_username')}</span>
      <span style="min-width: 120px;">${t('admin_users.header_display_name')}</span>
      <span style="min-width: 200px;">${t('admin_users.header_email')}</span>
      <span style="margin-left: auto;">${t('admin_users.header_joined')}</span>
    `
    element.appendChild(tableHeader)

    const tableBody = document.createElement('div')
    tableBody.id = 'users-list'
    tableBody.style.cssText = `
      background: #1e293b;
      border-radius: 0 0 8px 8px;
    `

    if (filteredUsers.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = searchQuery ? t('admin_users.no_results') : t('admin_users.empty')
      empty.style.cssText = 'color: #64748b; font-size: 14px; padding: 24px; text-align: center;'
      tableBody.appendChild(empty)
    } else {
      filteredUsers.forEach(user => {
        tableBody.appendChild(createUserRow(user))
      })
    }

    element.appendChild(tableBody)
  }

  const renderUsersList = () => {
    const tableBody = element.querySelector('#users-list') as HTMLElement
    if (tableBody) {
      tableBody.innerHTML = ''
      if (filteredUsers.length === 0) {
        const empty = document.createElement('div')
        empty.textContent = searchQuery ? t('admin_users.no_results') : t('admin_users.empty')
        empty.style.cssText = 'color: #64748b; font-size: 14px; padding: 24px; text-align: center;'
        tableBody.appendChild(empty)
      } else {
        filteredUsers.forEach(user => {
          tableBody.appendChild(createUserRow(user))
        })
      }
    }
  }

  const init = async () => {
    users = await fetchUsers() || []
    filteredUsers = [...users]
    await render()
  }

  init()

  return {
    getElement: () => element,
    refresh: async () => {
      users = await fetchUsers() || []
      filterUsers()
      await render()
    },
    destroy: () => {
      if (element && element.parentNode) {
        element.parentNode.removeChild(element)
      }
    }
  }
}
