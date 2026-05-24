# Flaxia Technical Whitepaper

## Executive Summary

Flaxia is an innovative chronological social networking service (SNS) that reimagines social media posts as living, interactive applications. Unlike traditional platforms where posts are static text and media, Flaxia enables users to create and share fully interactive content packaged as ZIP files, which can contain HTML5 applications, Unity WebGL games, Flash animations, and other dynamic experiences.

Built on Cloudflare's edge computing infrastructure, Flaxia leverages serverless architecture to deliver a highly scalable, secure, and performant platform. The system integrates with the Fediverse through ActivityPub protocol (WIP), enabling decentralized social networking while maintaining unique interactive content capabilities.

## Technical Architecture

### Core Infrastructure

Flaxia operates on a modern edge computing stack designed for global scalability and low-latency content delivery:

**Runtime Environment**
- **Cloudflare Pages**: Static asset hosting and frontend deployment
- **Cloudflare Workers**: Serverless API execution at the edge
- **Compatibility Date**: 2024-01-01 with Node.js compatibility flags

**Database Layer**
- **Cloudflare D1**: SQLite-based distributed database
- **Migration System**: Version-controlled schema evolution
- **Query Optimization**: Indexed queries for common access patterns

**Storage Infrastructure**
- **Cloudflare R2**: Object storage for media files and ZIP payloads
- **CDN Integration**: Automatic global content caching
- **File Size Limits**: 10MB maximum for uploads, 100MB extracted size for ZIPs

**Message Queuing**
- **Cloudflare Queues**: ActivityPub delivery queue for federated content
- **Asynchronous Processing**: Non-blocking federation operations

### API Architecture

**Framework**: Hono - Lightweight, type-safe web framework for Cloudflare Workers

**API Structure**:
```
/api/
  /auth/*          - Authentication endpoints
  /upload/*        - Direct file upload (pre-signed)
  /images/*        - Image proxy from R2
  /audio/*         - Audio file proxy
  /zip/*           - ZIP file serving
  /wvfs-zip/*      - WVFS virtual file system
  /swf/*           - Flash file serving
  /ads/*           - Advertisement payloads
  /thumbnail/*     - Thumbnail images
  /actors/*        - ActivityPub actor endpoints (WIP)
  /.well-known/*   - WebFinger protocol (WIP)
  /notifications/* - User notifications (WIP)
  /admin/*         - Administrative functions (WIP)
```

**Authentication Middleware**:
- Session-based authentication with secure cookies
- Public route detection for guest access
- Rate limiting integration for abuse prevention
- User context injection for protected routes

**Rate Limiting**:
- Cloudflare KV-based distributed rate limiting
- Per-endpoint limits (e.g., 3 registrations/hour, 20 logins/hour)
- IP-based tracking with CF-Connecting-IP header

### Database Schema

**Core Tables**:

```sql
-- Users and authentication
users (id, email, password_hash, username, display_name, bio, avatar_key, language, ng_words, created_at)
sessions (id, user_id, expires_at)

-- Content and interactions
posts (id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, created_at, status)
replies (id, post_id, user_id, username, text, created_at)
freshs (post_id, user_id) -- "Fresh" votes (unique engagement mechanism)

-- Social graph
follows (follower_id, followee_id)

-- ActivityPub federation
actor_keys (user_id, public_key_pem, private_key_pem, created_at)
ap_followers (user_id, follower_url, created_at)

-- Notifications
notifications (id, user_id, type, post_id, actor_id, read, created_at)

-- Moderation
reports (id, reporter_id, post_id, category, reason, created_at)
hidden_posts (id, post_id, moderator_id, reason, created_at)

-- Advertisement system
ads (id, title, body_text, click_url, payload_key, payload_type, impressions, clicks, active, created_at)
ad_interactions (id, ad_id, interaction_type, created_at)
```

**Indexes**: Optimized for common query patterns including chronological feeds, user profiles, and social graph traversal.

## Interactive Content System

### ZIP Execution Engine

Flaxia's core innovation is the ability to treat posts as executable applications. This is achieved through a sophisticated ZIP execution pipeline:

**Client-Side Execution** (`src/lib/zip-executor.ts`):

1. **ZIP Fetching**: Retrieve ZIP file from R2 storage
2. **Validation**: Comprehensive security checks including:
   - File count limit (max 255 files)
   - Path length restrictions (max 255 characters)
   - Directory depth limits (max 10 levels)
   - Total size validation (max 100MB extracted)
   - Nested ZIP prevention
   - Symbolic link detection
   - Path traversal protection
   - File type whitelist enforcement

3. **Blob URL Generation**: Convert ZIP contents to browser-accessible blob URLs
4. **HTML Rewriting**: Modify `index.html` to reference blob URLs for all assets
5. **Sandboxed Execution**: Load content in isolated iframe with restricted permissions

**Allowed File Types**:
- Web content: `.html`, `.css`, `.js`, `.json`, `.txt`
- Media: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.mp3`, `.wav`, `.ogg`, `.mp4`, `.webm`
- WebGL/Game: `.wasm`, `.glsl`, `.wgsl`, `.unityweb`, `.data`, `.wasm.code`, `.wasm.framework`
- Legacy: `.ico`, `.rsp`

### WVFS (Web Virtual File System)

The server-side WVFS system (`src/lib/wvfs-zip-server.ts`) provides efficient file serving from ZIP archives:

**Architecture**:
- **In-Memory Storage**: Map-based storage for extracted ZIP contents
- **Path Normalization**: Handles relative paths and directory traversal
- **Fallback Resolution**: Multiple lookup strategies for missing files
- **Base Tag Injection**: Automatic base URL injection for HTML files

**Serving Pipeline**:
1. **Extraction**: Use `fflate` for server-side ZIP extraction
2. **Validation**: Apply same security checks as client-side
3. **Storage**: Cache extracted files in memory
4. **Serving**: Respond to file requests with proper MIME types
5. **Cleanup**: Memory management for unused ZIPs

**API Endpoints**:
- `GET /api/wvfs-zip/:postId/*` - Serve individual files
- `GET /api/wvfs-zip/:postId` - Serve index.html by default

### Security Sandbox

**Isolation Strategy**:
```html
<iframe 
  sandbox="allow-scripts allow-pointer-lock allow-fullscreen"
  allow="fullscreen"
  referrerpolicy="no-referrer">
```

**Permissions**:
- `allow-scripts`: JavaScript execution required for interactive content
- `allow-pointer-lock`: Game control input
- `allow-fullscreen`: Immersive experiences
- **Explicitly denied**: `allow-same-origin`, `allow-forms`, `allow-popups`

**Security Benefits**:
- No access to parent window DOM
- No access to cookies or localStorage
- No network requests to different origins
- Isolated JavaScript execution context

### Fresh Bridge API

The Fresh Bridge (`sandbox/fresh-bridge.js`) enables secure communication between sandboxed content and the parent application:

**API Methods**:
```javascript
FreshBridge.requestFullscreen()   // Request fullscreen mode
FreshBridge.requestFresh()        // Request "Fresh" vote
FreshBridge.postScore(score, label)  // Submit game score
FreshBridge.onMessage(callback)   // Listen for parent messages
```

**Message Types**:
- `REQUEST_FULLSCREEN`: Parent requests fullscreen
- `FULLSCREEN_GRANTED/DENIED`: Response to fullscreen request
- `REQUEST_FRESH`: User requests to give "Fresh" vote
- `FRESH_GRANTED/DENIED`: Response to Fresh request
- `POST_SCORE`: Submit game score with label
- `SCORE_SUBMITTED`: Confirmation of score submission

**Security**:
- Origin validation using `FRESH_PARENT_ORIGIN`
- PostMessage communication with explicit origin checking
- Type-safe message handling

## Social Features

### Authentication System

**Custom Session-Based Authentication** (`functions/lib/auth.ts`):

**Password Security**:
- PBKDF2 with SHA-256 (100,000 iterations)
- 16-byte random salt per password
- Timing-safe comparison to prevent timing attacks
- Combined salt+hash storage in base64

**Session Management**:
- 7-day session expiration
- Secure, HttpOnly, SameSite=Lax cookies
- UUID-based session tokens (32 characters)
- Database-backed session storage with expiration

**User Registration**:
- Email validation with regex
- Password requirements (8-128 characters)
- Username validation (alphanumeric, 1-20 characters)
- Case-insensitive username uniqueness
- Display name limits (max 50 characters)

### Social Graph

**Following System**:
- Bidirectional follow relationships
- `INSERT OR IGNORE` for idempotent operations
- Efficient follower/followee queries with indexes
- User suggestions based on non-followed users

**Activity Feed**:
- Chronological post ordering
- Support for hashtags and tagging
- Fresh vote counting for engagement metrics
- Reply threading for conversations

### Content Interaction

**Fresh Voting System**:
- Unique "Fresh" engagement mechanism (similar to likes)
- Database-enforced uniqueness (post_id + user_id primary key)
- Real-time fresh count updates
- Integration with interactive content via Fresh Bridge

**Reply System**:
- Threaded conversations
- Reply-to-reply support
- Chronological ordering within threads
- User attribution and timestamps

**Notifications**:
- Multi-type notification system (reported, fresh, warned, hidden)
- Unread count tracking
- Batch read-all functionality
- Actor information for federated notifications

## ActivityPub Integration

### Fediverse Compatibility

Flaxia implements some of the ActivityPub protocol for decentralized social networking:

**Actor Representation**:
```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Person",
  "id": "https://flaxia.app/api/actors/username",
  "preferredUsername": "username",
  "name": "Display Name",
  "summary": "Bio",
  "inbox": "https://flaxia.app/api/users/username/inbox",
  "outbox": "https://flaxia.app/api/actors/username/outbox",
  "followers": "https://flaxia.app/api/actors/username/followers",
  "following": "https://flaxia.app/api/actors/username/following",
  "publicKey": {
    "id": "https://flaxia.app/api/actors/username#main-key",
    "owner": "https://flaxia.app/api/actors/username",
    "publicKeyPem": "PEM-encoded public key"
  }
}
```

**Cryptographic Security** (`functions/lib/activitypub/signature.ts`):

**Key Management**:
- RSA key pairs generated per user
- PEM format storage in database
- Public key exposed via actor endpoint
- Private key used for signing outgoing requests

**HTTP Signature Verification**:
- RSASSA-PKCS1-v1_5 with SHA-256
- Request signing with date, digest, and host headers
- Signature header parsing and validation
- Base64 decoding with URL-safe character handling
- Replay attack protection (±30 minute timestamp window)

**Digest Verification**:
- SHA-256 hash of request body
- Digest header validation
- Content integrity verification

**Content Types**:
- **Note**: Individual post content
- **Create**: Activity for creating notes
- **Delete**: Activity for deleting notes
- **Follow**: Activity for following actors
- **Accept/Reject**: Response to follow requests

**WebFinger Protocol**:
- User discovery via `acct:username@domain`
- Resource parameter validation
- Domain matching against BASE_URL
- Case-insensitive username lookup

## Advertisement System

### Interactive Ad Platform

Flaxia includes a sophisticated advertisement system that leverages the same interactive content infrastructure:

**Ad Types**:
- **ZIP**: Interactive applications (same as posts)
- **SWF**: Flash animations
- **GIF**: Animated images
- **Image**: Static images

**Ad Structure**:
```sql
ads (id, title, body_text, click_url, payload_key, 
     payload_type, impressions, clicks, active, created_at)
```

**Interaction Tracking**:
- Play tracking for ZIP/SWF ads
- Impression counting
- Click-through measurement
- Per-ad interaction logs

**Serving Strategy**:
- Random selection from active ads
- Payload serving via `/api/ads/:id/payload`
- Thumbnail support for preview
- WVFS integration for ZIP ads

## Security & Privacy

### Multi-Layer Security

**Content Validation**:
- ZIP file structure validation
- File type whitelist enforcement
- Size limits (upload and extracted)
- Path traversal prevention
- Symbolic link detection
- Nested archive prevention

**Sandbox Isolation**:
- iframe sandbox with restricted permissions
- No same-origin access
- No cookie/storage access
- Network request restrictions
- Referrer policy enforcement

**Input Sanitization**:
- DOMPurify for HTML sanitization
- Markdown-it with safe configuration
- KaTeX for secure math rendering
- Length limits on user input

**Rate Limiting**:
- Per-IP endpoint limits
- Distributed KV storage
- Time-based windows
- Configurable limits per endpoint

### Privacy Protection

**User Privacy Controls**:
- NG word filtering (user-configurable)
- Content visibility settings (public/followers/private)
- Profile information control
- Avatar key management

**Data Minimization**:
- Only necessary data collection
- Session-based authentication (no tokens in localStorage)
- Secure cookie attributes
- Minimal data exposure in API responses

**Content Moderation**:
- User reporting system
- Admin content hiding
- Category-based reporting
- Moderator audit trail

## Performance & Scalability

### Edge Computing Benefits

**Global Distribution**:
- Cloudflare's 300+ edge locations
- Automatic request routing to nearest edge
- Reduced latency for global users
- No single point of failure

**Serverless Architecture**:
- Automatic scaling based on traffic
- No server management overhead
- Pay-per-use pricing model
- Zero cold-start time with Pages Functions

### Caching Strategy

**Static Assets**:
- Long cache headers (1 year) for images/audio
- CDN-level caching
- Cache invalidation on content updates

**Dynamic Content**:
- Database query optimization
- Indexed lookups for common patterns
- Session caching with JOIN queries
- KV-based rate limit caching

**WVFS Optimization**:
- In-memory file serving
- Path normalization for cache hits
- Efficient blob URL generation
- Cleanup of unused ZIPs

### Performance Monitoring

**Client-Side Metrics**:
- Performance API integration
- Navigation timing tracking
- Resource loading monitoring
- Custom performance events

**Server-Side Logging**:
- Request/response logging
- Error tracking
- ActivityPub delivery logs
- Security event monitoring

## Future Development

### Extensibility

**Plugin Architecture**:
- Component-based frontend design
- Modular API endpoints
- Pluggable content types
- Extensible Fresh Bridge API

**Federation Enhancements**:
- Fully compliant ActivityPub support
- Cross-platform content sharing
- Improved discovery mechanisms
- Enhanced security protocols

### Scalability Roadmap

**Content Delivery**:
- Enhanced WVFS caching
- Distributed ZIP extraction
- Edge-based content preprocessing
- Adaptive quality streaming

**User Growth**:
- Horizontal database scaling
- Sharding strategies
- Geographic data distribution
- Load balancing optimization

**Feature Expansion**:
- Real-time collaboration
- Multi-user interactive content
- Enhanced moderation tools
- Advanced analytics platform

## Conclusion

Flaxia represents a paradigm shift in social networking, transforming static posts into living, interactive applications. By leveraging modern edge computing infrastructure, implementing robust security measures, and embracing decentralized federation through ActivityPub, Flaxia provides a scalable, secure, and innovative platform for the next generation of social content.

The architecture's emphasis on sandboxed execution, comprehensive validation, and privacy protection ensures that users can safely create and share interactive experiences while maintaining control over their data and social connections. As the platform evolves, the modular design and extensible architecture will support continued innovation in social media interactivity.

