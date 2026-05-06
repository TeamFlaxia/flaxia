import { isCrawler } from '../../src/lib/is-crawler'
import { renderOgHtml } from '../../src/lib/og-html'

const r2Url = (key: string) => `https://r2.flaxia.com/${key}`

type Env = {
  DB: D1Database
  BASE_URL?: string
}

export async function onRequest(context: { request: Request; env: Env; next: () => Promise<Response> }): Promise<Response> {
  const { request, env, next } = context
  const userAgent = request.headers.get('user-agent') || ''
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app'
  const defaultImage = `${baseUrl}/og-default-v2.png`

  if (!isCrawler(userAgent)) {
    return next()
  }

  const url = new URL(request.url)
  const id = url.pathname.split('/')[2]

  if (!id) {
    return new Response(renderOgHtml({
      title: 'Post not found',
      description: 'Post not found',
      image: defaultImage,
      url: `${baseUrl}/thread/`,
      type: 'article',
      twitterCard: 'summary_large_image'
    }, baseUrl), {
      status: 404,
      headers: { 'Content-Type': 'text/html' }
    })
  }

  try {
    const stmt = env.DB.prepare(`
      SELECT posts.*, users.display_name, users.username
      FROM posts
      JOIN users ON posts.user_id = users.id
      WHERE posts.id = ?
    `)
    const result: any = await stmt.bind(id).first()

    if (!result) {
      return new Response(renderOgHtml({
        title: 'Post not found',
        description: 'Post not found',
        image: defaultImage,
        url: `${baseUrl}/thread/${id}`,
        type: 'article',
        twitterCard: 'summary_large_image'
      }, baseUrl), {
        status: 404,
        headers: { 'Content-Type': 'text/html' }
      })
    }

    const image = result.gif_key ? r2Url(String(result.gif_key)) : defaultImage

    return new Response(renderOgHtml({
      title: String(result.display_name),
      description: String(result.text),
      image,
      url: `${baseUrl}/thread/${id}`,
      type: 'article',
      twitterCard: 'summary_large_image'
    }, baseUrl), {
      headers: { 'Content-Type': 'text/html' }
    })
  } catch (error) {
    console.error('OGP fetch error:', error)
    return new Response(renderOgHtml({
      title: 'Post not found',
      description: 'Post not found',
      image: defaultImage,
      url: `${baseUrl}/thread/${id}`,
      type: 'article',
      twitterCard: 'summary_large_image'
    }, baseUrl), {
      status: 404,
      headers: { 'Content-Type': 'text/html' }
    })
  }
}
