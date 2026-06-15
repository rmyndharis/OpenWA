# 03 - System Architecture

## 3.1 Architecture Overview

### High-Level Architecture

```mermaid
flowchart TB
    subgraph Clients["Clients"]
        C1[External Apps]
        C2[Dashboard]
        C3[n8n/Automation]
    end
    
    subgraph OpenWA["OpenWA Platform"]
        subgraph API["API Layer"]
            REST[REST API<br/>NestJS]
            WS[WebSocket<br/>Real-time]
            SWAGGER[Swagger<br/>Documentation]
        end
        
        subgraph Core["Core Services"]
            SM[Session<br/>Manager]
            MM[Message<br/>Manager]
            WH[Webhook<br/>Manager]
            QM[Queue<br/>Manager]
        end
        
        subgraph Engine["WhatsApp Engine"]
            WW[whatsapp-web.js]
            PP[Puppeteer]
            CH[Chrome/Chromium]
        end
        
        subgraph Storage["Storage Layer"]
            DB[(Database<br/>PostgreSQL/SQLite)]
            REDIS[(Redis<br/>Cache/Queue)]
            FS[File Storage<br/>Media Files]
        end
    end
    
    subgraph External["External"]
        WA[WhatsApp<br/>Servers]
        WEBHOOK[Webhook<br/>Endpoints]
    end
    
    Clients --> API
    API --> Core
    Core --> Engine
    Core --> Storage
    Engine --> WA
    Core --> WEBHOOK
```

### Component Interaction

```mermaid
sequenceDiagram
    participant Client
    participant API as REST API
    participant SM as Session Manager
    participant Engine as WA Engine
    participant DB as Database
    participant WA as WhatsApp
    
    Client->>API: Create Session
    API->>SM: createSession()
    SM->>DB: Save session config
    SM->>Engine: Initialize
    Engine->>WA: Connect
    WA-->>Engine: QR Code
    Engine-->>SM: QR Ready
    SM-->>API: QR Code data
    API-->>Client: QR Code response
```

## 3.2 Pluggable Architecture Philosophy

OpenWA is designed with a **Pluggable Architecture** that allows infrastructure components to be swapped without changing application code. This enables flexible deployments ranging from minimal single-session bots to larger single-node, multi-session installs.

> **Note — single-instance:** the live WhatsApp engine layer is stateful and held in-process
> (an in-memory `Map` in `SessionService`). OpenWA currently runs as **one API instance per
> session-data volume**; horizontal scaling across multiple API replicas is a future design
> (not implemented). See [13 - Horizontal Scaling](13-horizontal-scaling.md).

### Design Philosophy

```mermaid
flowchart TB
    subgraph Philosophy["Core Design Principles"]
        P1[Program to Interfaces]
        P2[Dependency Injection]
        P3[Configuration-driven]
        P4[Zero Code Changes]
    end

    subgraph Benefits["Benefits"]
        B1[Scale Up/Down Freely]
        B2[Test in Isolation]
        B3[Swap Implementations]
        B4[Environment-specific Config]
    end

    P1 --> B3
    P2 --> B2
    P3 --> B4
    P4 --> B1
```

**Key Principles:**

| Principle | Description | Example |
|-----------|-------------|---------|
| **Program to Interfaces** | Core code depends on abstract interfaces, not concrete implementations | `IStorageAdapter` instead of `S3Client` |
| **Dependency Injection** | Adapters injected at runtime via NestJS DI container | `@Inject('STORAGE_ADAPTER')` |
| **Configuration-driven** | Adapter selection via environment variables | `STORAGE_TYPE=s3` |
| **Zero Code Changes** | Switch adapters without modifying application code | Change `.env`, restart |

### Adapter Categories

```mermaid
flowchart LR
    subgraph Core["Application Core"]
        APP[Business Logic]
    end

    subgraph Interfaces["Adapter Interfaces"]
        IE[IWhatsAppEngine]
        ID[IDatabaseAdapter]
        IS[IStorageAdapter]
        IC[ICacheAdapter]
    end

    subgraph Implementations["Concrete Implementations"]
        subgraph Engine
            E1[whatsapp-web.js]
            E2[Baileys]
            E3[MockEngine]
        end
        subgraph Database
            D1[SQLite]
            D2[PostgreSQL]
        end
        subgraph Storage
            S1[LocalFS]
            S2[S3/MinIO]
        end
        subgraph Cache
            C1[In-Memory]
            C2[Redis]
        end
    end

    APP --> Interfaces
    IE -.-> Engine
    ID -.-> Database
    IS -.-> Storage
    IC -.-> Cache
```

### Adapter Lifecycle State Machine

Each adapter follows a consistent lifecycle:

```mermaid
stateDiagram-v2
    [*] --> Uninitialized: Create Instance

    Uninitialized --> Initializing: initialize()
    Initializing --> Ready: Success
    Initializing --> Failed: Error

    Ready --> Active: First operation
    Active --> Ready: Operation complete
    Active --> Degraded: Transient error
    Degraded --> Active: Auto-recover
    Degraded --> Failed: Max retries exceeded

    Ready --> Disconnecting: shutdown()
    Active --> Disconnecting: shutdown()
    Degraded --> Disconnecting: shutdown()

    Disconnecting --> Disconnected: Cleanup complete
    Failed --> Disconnecting: shutdown()

    Disconnected --> [*]
```

```typescript
// common/interfaces/adapter-lifecycle.interface.ts

export enum AdapterState {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  READY = 'ready',
  ACTIVE = 'active',
  DEGRADED = 'degraded',
  FAILED = 'failed',
  DISCONNECTING = 'disconnecting',
  DISCONNECTED = 'disconnected',
}

export interface IAdapterLifecycle {
  /** Current adapter state */
  getState(): AdapterState;

  /** Initialize adapter with configuration */
  initialize(config: AdapterConfig): Promise<void>;

  /** Check if adapter is operational */
  isHealthy(): Promise<boolean>;

  /** Graceful shutdown */
  shutdown(): Promise<void>;

  /** State change event emitter */
  onStateChange(handler: (state: AdapterState) => void): void;
}
```

### Dependency Injection Configuration

OpenWA uses NestJS Dynamic Modules for adapter injection:

```typescript
// adapters/adapters.module.ts

import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Global()
@Module({})
export class AdaptersModule {
  static forRoot(): DynamicModule {
    return {
      module: AdaptersModule,
      providers: [
        // Database Adapter
        {
          provide: 'DATABASE_ADAPTER',
          useFactory: (config: ConfigService) => {
            const type = config.get('database.type', 'sqlite');
            return DatabaseAdapterFactory.create(type, config);
          },
          inject: [ConfigService],
        },

        // Storage Adapter
        {
          provide: 'STORAGE_ADAPTER',
          useFactory: (config: ConfigService) => {
            const type = config.get('storage.type', 'local');
            return StorageAdapterFactory.create(type, config);
          },
          inject: [ConfigService],
        },

        // Cache Adapter
        {
          provide: 'CACHE_ADAPTER',
          useFactory: (config: ConfigService) => {
            const type = config.get('cache.type', 'memory');
            return CacheAdapterFactory.create(type, config);
          },
          inject: [ConfigService],
        },

        // Engine Adapter
        {
          provide: 'ENGINE_FACTORY',
          useFactory: (config: ConfigService) => {
            return new EngineFactory(config);
          },
          inject: [ConfigService],
        },
      ],
      exports: [
        'DATABASE_ADAPTER',
        'STORAGE_ADAPTER',
        'CACHE_ADAPTER',
        'ENGINE_FACTORY',
      ],
    };
  }
}
```

### Using Adapters in Services

```typescript
// modules/message/message.service.ts

@Injectable()
export class MessageService {
  constructor(
    @Inject('STORAGE_ADAPTER')
    private readonly storage: IStorageAdapter,

    @Inject('CACHE_ADAPTER')
    private readonly cache: ICacheAdapter,
  ) {}

  async saveMediaMessage(sessionId: string, media: Buffer, filename: string) {
    // Storage adapter handles whether it's local FS or S3
    const result = await this.storage.upload({
      buffer: media,
      filename,
      folder: `sessions/${sessionId}/media`,
    });

    // Cache adapter handles whether it's in-memory or Redis
    await this.cache.set(`media:${result.key}`, result.url, 3600);

    return result;
  }
}
```

### Runtime Configuration Flow

```mermaid
sequenceDiagram
    participant Env as .env File
    participant Config as ConfigService
    participant Factory as AdapterFactory
    participant DI as NestJS DI Container
    participant Service as Application Service

    Note over Env: STORAGE_TYPE=s3
    Env->>Config: Load configuration
    Config->>Factory: Get storage.type = 's3'
    Factory->>Factory: new S3StorageAdapter(config)
    Factory->>DI: Register as 'STORAGE_ADAPTER'
    DI->>Service: Inject IStorageAdapter
    Service->>Service: Use adapter (doesn't know it's S3)
```

### Adapter Selection Matrix

| Environment | Database | Storage | Cache | Engine | Use Case |
|-------------|----------|---------|-------|--------|----------|
| **Development** | SQLite | Local | Memory | Mock | Fast iteration, testing |
| **Testing** | SQLite | Local | Memory | Mock | CI/CD, unit tests |
| **Staging** | PostgreSQL | Local | Redis | whatsapp-web.js | Pre-production validation |
| **Production (Small)** | SQLite | Local | Memory | whatsapp-web.js | 1-3 sessions, VPS |
| **Production (Medium)** | PostgreSQL | Local | Redis | whatsapp-web.js | 5-10 sessions |
| **Production (Large)** | PostgreSQL | S3/MinIO | Redis | whatsapp-web.js | 10+ sessions, HA |

### Hot-Swap Considerations

> **Note:** Adapter hot-swap (changing adapter without restart) is **not supported** in v1.0. Changing adapter requires application restart.

Future considerations for hot-swap:
- Graceful connection draining
- State migration between adapters
- Zero-downtime switching

```mermaid
flowchart TD
    A[Config Change Detected] --> B{Hot-swap Supported?}
    B -->|v1.0: No| C[Log Warning]
    C --> D[Require Restart]

    B -->|Future: Yes| E[Drain Connections]
    E --> F[Initialize New Adapter]
    F --> G[Migrate State]
    G --> H[Switch Traffic]
    H --> I[Shutdown Old Adapter]
```

## 3.3 Layered Architecture

### Layered Architecture Pattern

```mermaid
flowchart TB
    subgraph Presentation["Presentation Layer"]
        direction LR
        REST[REST Controllers]
        WS[WebSocket Gateways]
        SWAGGER[OpenAPI Docs]
    end
    
    subgraph Application["Application Layer"]
        direction LR
        SESS[Session Service]
        MSG[Message Service]
        WH[Webhook Service]
        AUTH[Auth Service]
    end
    
    subgraph Domain["Domain Layer"]
        direction LR
        ENT[Entities]
        REPO[Repository Interfaces]
        EVT[Domain Events]
    end
    
    subgraph Infrastructure["Infrastructure Layer"]
        direction LR
        DB[Database]
        CACHE[Redis]
        ENGINE[WA Engine]
        HTTP[HTTP Client]
    end
    
    Presentation --> Application
    Application --> Domain
    Application --> Infrastructure
    Domain --> Infrastructure
```

## 3.4 Module Structure

### NestJS Module Organization

```
src/
├── main.ts                     # Application entry point
├── app.module.ts               # Root module
│
├── common/                     # Shared utilities
│   ├── decorators/
│   ├── filters/
│   ├── guards/
│   ├── interceptors/
│   ├── pipes/
│   └── utils/
│
├── config/                     # Configuration
│   ├── config.module.ts
│   ├── config.service.ts
│   └── configuration.ts
│
├── modules/
│   ├── session/               # Session management
│   │   ├── session.module.ts
│   │   ├── session.controller.ts
│   │   ├── session.service.ts
│   │   ├── session.repository.ts
│   │   ├── dto/
│   │   └── entities/
│   │
│   ├── message/               # Message handling
│   │   ├── message.module.ts
│   │   ├── message.controller.ts
│   │   ├── message.service.ts
│   │   └── dto/
│   │
│   ├── webhook/               # Webhook management
│   │   ├── webhook.module.ts
│   │   ├── webhook.controller.ts
│   │   ├── webhook.service.ts
│   │   └── dto/
│   │
│   ├── contact/               # Contact management
│   │   ├── contact.module.ts
│   │   ├── contact.controller.ts
│   │   └── contact.service.ts
│   │
│   ├── group/                 # Group management
│   │   ├── group.module.ts
│   │   ├── group.controller.ts
│   │   └── group.service.ts
│   │
│   ├── auth/                  # Authentication
│   │   ├── auth.module.ts
│   │   ├── auth.guard.ts
│   │   └── api-key.strategy.ts
│   │
│   └── health/                # Health checks
│       ├── health.module.ts
│       └── health.controller.ts
│
├── engine/                    # WhatsApp engine wrapper
│   ├── engine.module.ts
│   ├── engine.service.ts
│   ├── engine.factory.ts
│   └── interfaces/
│
├── queue/                     # Job queue
│   ├── queue.module.ts
│   ├── processors/
│   └── jobs/
│
└── database/                  # Database
    ├── database.module.ts
    ├── migrations/
    └── seeds/
```

## 3.5 Core Components Design

### 3.5.1 Session Manager

```mermaid
classDiagram
    class SessionManager {
        -sessions: Map~string, Session~
        -repository: SessionRepository
        -engineFactory: EngineFactory
        +createSession(config): Session
        +getSession(id): Session
        +deleteSession(id): void
        +getAllSessions(): Session[]
        +restoreSessions(): void
    }
    
    class Session {
        +id: string
        +name: string
        +status: SessionStatus
        +engine: WhatsAppEngine
        +config: SessionConfig
        +createdAt: Date
        +start(): void
        +stop(): void
        +getQR(): string
    }
    
    class SessionStatus {
        <<enumeration>>
        CREATED
        INITIALIZING
        QR_READY
        AUTHENTICATED
        READY
        DISCONNECTED
        FAILED
    }
    
    class WhatsAppEngine {
        <<interface>>
        +initialize(): void
        +sendMessage(chatId, content): MessageResult
        +onMessage(callback): void
        +getContacts(): Contact[]
        +disconnect(): void
    }
    
    SessionManager --> Session
    Session --> SessionStatus
    Session --> WhatsAppEngine
```

### 3.5.2 Message Flow

```mermaid
flowchart TB
    subgraph Outbound["Outbound Message Flow"]
        A1[API Request] --> V1[Validate]
        V1 --> Q1[Queue Job]
        Q1 --> P1[Process]
        P1 --> E1[Engine Send]
        E1 --> R1[Response]
    end
    
    subgraph Inbound["Inbound Message Flow"]
        E2[Engine Event] --> P2[Process]
        P2 --> S2[Store]
        S2 --> W2[Webhook Queue]
        W2 --> D2[Deliver]
    end
```

### 3.5.3 Webhook System

```mermaid
classDiagram
    class WebhookManager {
        -webhooks: Webhook[]
        -httpClient: HttpService
        -queue: Queue
        +registerWebhook(config): Webhook
        +removeWebhook(id): void
        +dispatch(event): void
        -deliverWithRetry(webhook, payload): void
    }
    
    class Webhook {
        +id: string
        +url: string
        +events: EventType[]
        +secret: string
        +active: boolean
        +retryCount: number
        +headers: Record
    }
    
    class WebhookPayload {
        +event: EventType
        +timestamp: Date
        +sessionId: string
        +data: any
        +signature: string
    }
    
    class EventType {
        <<enumeration>>
        MESSAGE_RECEIVED
        MESSAGE_SENT
        MESSAGE_ACK
        SESSION_STATUS
        QR_CODE
    }
    
    WebhookManager --> Webhook
    WebhookManager --> WebhookPayload
    Webhook --> EventType
```

## 3.6 Data Flow Diagrams

### 3.6.1 Send Message Flow

```mermaid
flowchart LR
    subgraph Request["1. Request"]
        A[Client] -->|POST /messages| B[Controller]
    end
    
    subgraph Validation["2. Validation"]
        B --> C{Valid?}
        C -->|No| D[400 Error]
        C -->|Yes| E[Service]
    end
    
    subgraph Processing["3. Processing"]
        E --> F[Get Session]
        F --> G{Session Ready?}
        G -->|No| H[400 Error]
        G -->|Yes| I[Queue Job]
    end
    
    subgraph Execution["4. Execution"]
        I --> J[Worker]
        J --> K[Engine]
        K --> L[WhatsApp]
    end
    
    subgraph Response["5. Response"]
        L --> M[Success]
        M --> N[Store]
        N --> O[Response]
    end
```

### 3.6.2 Webhook Delivery Flow

```mermaid
flowchart TB
    A[Event Triggered] --> B[Create Payload]
    B --> C[Sign Payload]
    C --> D[Queue Delivery Job]
    D --> E[Worker Process]
    E --> F{Deliver}
    F -->|Success| G[Mark Delivered]
    F -->|Failed| H{Retry < 3?}
    H -->|Yes| I[Delay & Retry]
    I --> E
    H -->|No| J[Mark Failed]
    J --> K[Log Error]
```

## 3.7 Technology Architecture

### 3.7.1 Runtime Environment

```mermaid
flowchart TB
    subgraph Container["Docker Container"]
        subgraph Node["Node.js Runtime"]
            NEST[NestJS Application]
            WW[whatsapp-web.js]
        end
        
        subgraph Browser["Headless Browser"]
            CHROME[Chromium]
        end
        
        Node --> Browser
    end
    
    subgraph External["External Services"]
        PG[(PostgreSQL)]
        RD[(Redis)]
    end
    
    Container --> External
```

### 3.7.2 Deployment Architecture

```mermaid
flowchart TB
    subgraph Production["Production Environment"]
        LB[Load Balancer] --> I1[Instance 1]
        LB --> I2[Instance 2]
        LB --> I3[Instance N]
        
        I1 --> DB[(PostgreSQL)]
        I2 --> DB
        I3 --> DB
        
        I1 --> REDIS[(Redis)]
        I2 --> REDIS
        I3 --> REDIS
    end
    
    subgraph Storage["Shared Storage"]
        S3[S3/MinIO<br/>Media Files]
    end
    
    I1 --> S3
    I2 --> S3
    I3 --> S3
```

## 3.8 API Architecture

### RESTful API Design

```mermaid
flowchart LR
    subgraph Endpoints["API Endpoints"]
        direction TB
        S["/api/sessions"]
        M["/api/sessions/:sessionId/messages"]
        W["/api/sessions/:sessionId/webhooks"]
        C["/api/sessions/:sessionId/contacts"]
        G["/api/sessions/:sessionId/groups"]
        H["/health"]
    end
    
    subgraph Methods["HTTP Methods"]
        GET
        POST
        PUT
        DELETE
    end
    
    subgraph Format["Response Format"]
        JSON[JSON Response]
        ERR[Error Format]
        PAGE[Pagination]
    end
```

### API Response Structure

```typescript
// Success Response
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2025-02-02T10:00:00Z",
    "requestId": "uuid"
  }
}

// Error Response
{
  "success": false,
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session with id 'xxx' not found",
    "details": { ... }
  },
  "meta": {
    "timestamp": "2025-02-02T10:00:00Z",
    "requestId": "uuid"
  }
}

// Paginated Response
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

## 3.9 Security Architecture

```mermaid
flowchart TB
    subgraph External["External Request"]
        R[Request]
    end
    
    subgraph Security["Security Layers"]
        R --> HTTPS[HTTPS/TLS]
        HTTPS --> CORS[CORS Check]
        CORS --> RATE[Rate Limiter]
        RATE --> AUTH[API Key Auth]
        AUTH --> VAL[Input Validation]
        VAL --> APP[Application]
    end
    
    subgraph Internal["Internal Security"]
        APP --> ENC[Data Encryption]
        ENC --> LOG[Audit Logging]
    end
```

## 3.10 Error Handling Architecture

```mermaid
flowchart TB
    E[Error Occurs] --> T{Error Type}
    
    T -->|Validation| V[ValidationException]
    T -->|Not Found| N[NotFoundException]
    T -->|Auth| A[UnauthorizedException]
    T -->|Business| B[BusinessException]
    T -->|System| S[InternalException]
    
    V --> F[Exception Filter]
    N --> F
    A --> F
    B --> F
    S --> F
    
    F --> R[Formatted Response]
    F --> L[Log Error]
    
    L -->|Critical| AL[Alert]
```

## 3.11 Scalability Considerations

### Horizontal Scaling Strategy

```mermaid
flowchart TB
    subgraph Scaling["Scaling Strategy"]
        direction TB
        
        subgraph Stateless["Stateless Components"]
            API[API Servers]
            WORKER[Queue Workers]
        end
        
        subgraph Stateful["Stateful Components"]
            SESSION[Session Instances]
        end
        
        subgraph Shared["Shared State"]
            DB[(Database)]
            REDIS[(Redis)]
            S3[(Object Storage)]
        end
    end
    
    Stateless --> Shared
    Stateful --> Shared
```

### Session Affinity

```mermaid
flowchart LR
    subgraph Router["Request Router"]
        R[Request] --> H{Has Session ID?}
        H -->|Yes| A[Route to Affinity]
        H -->|No| B[Round Robin]
    end
    
    A --> I1[Instance 1<br/>Session A, B]
    A --> I2[Instance 2<br/>Session C, D]
    B --> I1
    B --> I2
```

---

## 3.12 Engine Abstraction Layer

> [!IMPORTANT]
> Engine abstraction is critical to mitigate **R001: WhatsApp Protocol Changes** in Risk Management. With an abstraction layer, we can easily switch to an alternative engine (e.g., Baileys) when needed.

### Strategy Pattern for Engine

```mermaid
classDiagram
    class IWhatsAppEngine {
        <<interface>>
        +initialize(config): Promise~void~
        +connect(): Promise~void~
        +disconnect(): Promise~void~
        +getStatus(): EngineStatus
        +sendTextMessage(chatId, text): Promise~MessageResult~
        +sendMediaMessage(chatId, media): Promise~MessageResult~
        +getQRCode(): Promise~string~
        +on(event, handler): void
        +off(event, handler): void
    }
    
    class WhatsAppWebJSEngine {
        -client: Client
        +initialize(): Promise~void~
        +connect(): Promise~void~
        +sendTextMessage(): Promise~MessageResult~
    }
    
    class BaileysEngine {
        -socket: WASocket
        +initialize(): Promise~void~
        +connect(): Promise~void~
        +sendTextMessage(): Promise~MessageResult~
    }
    
    class MockEngine {
        +initialize(): Promise~void~
        +sendTextMessage(): Promise~MessageResult~
    }
    
    class EngineFactory {
        +create(type: EngineType): IWhatsAppEngine
    }
    
    IWhatsAppEngine <|.. WhatsAppWebJSEngine
    IWhatsAppEngine <|.. BaileysEngine
    IWhatsAppEngine <|.. MockEngine
    EngineFactory --> IWhatsAppEngine
```

### Engine Interface Definition

```typescript
// engine/interfaces/whatsapp-engine.interface.ts
export interface IWhatsAppEngine {
  // Lifecycle
  initialize(config: EngineConfig): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  destroy(): Promise<void>;
  
  // Status
  getStatus(): EngineStatus;
  isReady(): boolean;
  
  // Authentication
  getQRCode(): Promise<string | null>;
  getAuthState(): AuthState;
  
  // Messaging
  sendTextMessage(chatId: string, text: string, options?: SendOptions): Promise<MessageResult>;
  sendMediaMessage(chatId: string, media: MediaInput, options?: SendOptions): Promise<MessageResult>;
  sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult>;
  sendContactMessage(chatId: string, contact: ContactInput): Promise<MessageResult>;
  
  // Contacts
  getContacts(): Promise<Contact[]>;
  getContactById(contactId: string): Promise<Contact | null>;
  getProfilePicture(contactId: string): Promise<string | null>;
  
  // Groups
  getGroups(): Promise<Group[]>;
  getGroupById(groupId: string): Promise<Group | null>;
  createGroup(name: string, participants: string[]): Promise<Group>;
  
  // Events
  on<T extends EngineEvent>(event: T, handler: EventHandler<T>): void;
  off<T extends EngineEvent>(event: T, handler: EventHandler<T>): void;
  once<T extends EngineEvent>(event: T, handler: EventHandler<T>): void;
}

export type EngineStatus = 'initializing' | 'qr_ready' | 'connecting' | 'ready' | 'disconnected' | 'error';

export interface EngineConfig {
  sessionId: string;
  authStatePath?: string;
  puppeteerOptions?: PuppeteerOptions;
  proxyUrl?: string;
}

export type EngineEvent = 
  | 'qr'
  | 'ready'
  | 'authenticated'
  | 'disconnected'
  | 'message'
  | 'message_ack'
  | 'message_revoke'
  | 'state_changed';
```

### Engine Factory

```typescript
// engine/engine.factory.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';
import { WhatsAppWebJSEngine } from './adapters/whatsapp-webjs.engine';
import { BaileysEngine } from './adapters/baileys.engine';
import { MockEngine } from './adapters/mock.engine';

export type EngineType = 'whatsapp-web.js' | 'baileys' | 'mock';

@Injectable()
export class EngineFactory {
  constructor(private config: ConfigService) {}
  
  create(type?: EngineType): IWhatsAppEngine {
    const engineType = type || this.config.get<EngineType>('engine.type', 'whatsapp-web.js');
    
    switch (engineType) {
      case 'whatsapp-web.js':
        return new WhatsAppWebJSEngine(this.config);
      
      case 'baileys':
        return new BaileysEngine(this.config);
      
      case 'mock':
        return new MockEngine();
      
      default:
        throw new Error(`Unknown engine type: ${engineType}`);
    }
  }
}
```

### WhatsApp-Web.js Adapter

```typescript
// engine/adapters/whatsapp-webjs.engine.ts
import { Client, LocalAuth } from 'whatsapp-web.js';
import { IWhatsAppEngine, EngineConfig, EngineStatus } from '../interfaces/whatsapp-engine.interface';

export class WhatsAppWebJSEngine implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = 'initializing';
  private eventEmitter = new EventEmitter();
  
  async initialize(config: EngineConfig): Promise<void> {
    this.client = new Client({
      authStrategy: new LocalAuth({ 
        clientId: config.sessionId,
        dataPath: config.authStatePath 
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ...config.puppeteerOptions,
      },
    });
    
    this.setupEventHandlers();
  }
  
  private setupEventHandlers(): void {
    this.client!.on('qr', (qr) => {
      this.status = 'qr_ready';
      this.eventEmitter.emit('qr', qr);
    });
    
    this.client!.on('ready', () => {
      this.status = 'ready';
      this.eventEmitter.emit('ready');
    });
    
    this.client!.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.eventEmitter.emit('disconnected', reason);
    });
    
    this.client!.on('message', (message) => {
      this.eventEmitter.emit('message', this.transformMessage(message));
    });
  }
  
  async connect(): Promise<void> {
    this.status = 'connecting';
    await this.client!.initialize();
  }
  
  async disconnect(): Promise<void> {
    await this.client?.logout();
    this.status = 'disconnected';
  }
  
  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    const message = await this.client!.sendMessage(chatId, text);
    return {
      messageId: message.id._serialized,
      timestamp: new Date(message.timestamp * 1000),
      status: 'sent',
    };
  }
  
  // ... other method implementations
}
```

### Baileys Adapter (Alternative Engine)

```typescript
// engine/adapters/baileys.engine.ts
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState 
} from '@whiskeysockets/baileys';
import { IWhatsAppEngine, EngineConfig, EngineStatus } from '../interfaces/whatsapp-engine.interface';

export class BaileysEngine implements IWhatsAppEngine {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private status: EngineStatus = 'initializing';
  private eventEmitter = new EventEmitter();
  
  async initialize(config: EngineConfig): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(
      config.authStatePath || `./.baileys_auth/${config.sessionId}`
    );
    
    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });
    
    this.socket.ev.on('creds.update', saveCreds);
    this.setupEventHandlers();
  }
  
  private setupEventHandlers(): void {
    this.socket!.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        this.status = 'qr_ready';
        this.eventEmitter.emit('qr', qr);
      }
      
      if (connection === 'open') {
        this.status = 'ready';
        this.eventEmitter.emit('ready');
      }
      
      if (connection === 'close') {
        this.status = 'disconnected';
        const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
        this.eventEmitter.emit('disconnected', { shouldReconnect });
      }
    });
    
    this.socket!.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key.fromMe) {
          this.eventEmitter.emit('message', this.transformMessage(msg));
        }
      }
    });
  }
  
  async connect(): Promise<void> {
    this.status = 'connecting';
    // Baileys connects during initialize
  }
  
  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    const result = await this.socket!.sendMessage(chatId, { text });
    return {
      messageId: result!.key.id!,
      timestamp: new Date(),
      status: 'sent',
    };
  }
  
  // ... other method implementations
}
```

### Engine Selection Configuration

```yaml
# .env
ENGINE_TYPE=whatsapp-web.js  # Options: whatsapp-web.js, baileys, mock

# For testing
ENGINE_TYPE=mock
```

### Migration Strategy

```mermaid
flowchart TB
    subgraph Current["Current State"]
        A[whatsapp-web.js\nPuppeteer-based]
    end
    
    subgraph Risk["Risk Detection"]
        B{Protocol\nBreaking?}
    end
    
    subgraph Migration["Migration Path"]
        C[Update whatsapp-web.js]
        D[Switch to Baileys]
        E[Community Fork]
    end
    
    subgraph Resolution["Resolution"]
        F[Service Restored]
    end
    
    A --> B
    B -->|Minor| C --> F
    B -->|Major wwebjs| D --> F
    B -->|Major Both| E --> F
```

### Engine Comparison

| Feature | whatsapp-web.js | Baileys |
|---------|-----------------|---------|
| **Protocol** | Web (Puppeteer) | Native WebSocket |
| **Resource Usage** | High (~500MB/session) | Low (~50MB/session) |
| **Stability** | Good | Good |
| **Community** | Large | Large |
| **Multi-device** | ✅ | ✅ |
| **QR Code** | ✅ | ✅ |
| **Phone Link** | ❌ | ✅ |
| **Maintenance** | Active | Active |

### Benefits of Abstraction

1. **Risk Mitigation** - Swap engines without changing application code
2. **Testing** - Use MockEngine for unit tests
3. **Flexibility** - Run different engines per environment
4. **Future-proof** - Easy to add new engine implementations
5. **A/B Testing** - Compare engine performance in production

---

## 3.13 Pluggable Adapters

OpenWA uses the adapter pattern for infrastructure components that can be swapped per deployment needs. This allows users with limited resources to run OpenWA without heavyweight external dependencies.

### Adapter Overview

```mermaid
flowchart TB
    subgraph Core["OpenWA Core"]
        APP[Application Logic]
    end

    subgraph Adapters["Pluggable Adapters"]
        subgraph Engine["WhatsApp Engine"]
            E1[whatsapp-web.js]
            E2[Baileys]
            E3[Mock]
        end

        subgraph Database["Database"]
            D1[SQLite]
            D2[PostgreSQL]
        end

        subgraph Storage["Media Storage"]
            S1[Local Filesystem]
            S2[S3]
            S3[MinIO]
        end

        subgraph Cache["Cache/Queue"]
            C1[In-Memory]
            C2[Redis]
        end
    end

    APP --> Engine
    APP --> Database
    APP --> Storage
    APP --> Cache
```

### Adapter Options

| Component | Options | Default | Notes |
|-----------|---------|---------|-------|
| **WhatsApp Engine** | whatsapp-web.js, Baileys, Mock | whatsapp-web.js | Mock for testing |
| **Database** | SQLite, PostgreSQL | SQLite | PostgreSQL for large-scale production |
| **Media Storage** | Local, S3, MinIO | Local | S3/MinIO for horizontal scaling |
| **Cache/Queue** | In-Memory, Redis | In-Memory | Redis for multi-instance |

### 3.13.1 Storage Adapter

The media storage abstraction enables storing media files (images, videos, documents) across different backends.

#### Interface Definition

```typescript
// storage/interfaces/storage-adapter.interface.ts
export interface IStorageAdapter {
  /**
   * Upload file to storage
   */
  upload(file: UploadInput): Promise<StorageResult>;

  /**
   * Download file from storage
   */
  download(key: string): Promise<Buffer>;

  /**
   * Delete file from storage
   */
  delete(key: string): Promise<void>;

  /**
   * Get a public/signed URL for a file
   */
  getUrl(key: string, expiresIn?: number): Promise<string>;

  /**
   * Check whether a file exists
   */
  exists(key: string): Promise<boolean>;
}

export interface UploadInput {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  folder?: string;
}

export interface StorageResult {
  key: string;
  url: string;
  size: number;
  mimetype: string;
}
```

#### Local Storage Adapter

```typescript
// storage/adapters/local-storage.adapter.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IStorageAdapter, UploadInput, StorageResult } from '../interfaces/storage-adapter.interface';

@Injectable()
export class LocalStorageAdapter implements IStorageAdapter {
  private readonly basePath: string;
  private readonly baseUrl: string;

  constructor(private config: ConfigService) {
    this.basePath = config.get('storage.local.path', './media');
    this.baseUrl = config.get('storage.local.baseUrl', '/media');
  }

  async upload(input: UploadInput): Promise<StorageResult> {
    const folder = input.folder || 'uploads';
    const key = `${folder}/${Date.now()}-${input.filename}`;
    const fullPath = path.join(this.basePath, key);

    // Ensure directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Write file
    await fs.writeFile(fullPath, input.buffer);

    return {
      key,
      url: `${this.baseUrl}/${key}`,
      size: input.buffer.length,
      mimetype: input.mimetype,
    };
  }

  async download(key: string): Promise<Buffer> {
    const fullPath = path.join(this.basePath, key);
    return fs.readFile(fullPath);
  }

  async delete(key: string): Promise<void> {
    const fullPath = path.join(this.basePath, key);
    await fs.unlink(fullPath).catch(() => {}); // Ignore if not exists
  }

  async getUrl(key: string): Promise<string> {
    return `${this.baseUrl}/${key}`;
  }

  async exists(key: string): Promise<boolean> {
    const fullPath = path.join(this.basePath, key);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}
```

#### S3/MinIO Storage Adapter

```typescript
// storage/adapters/s3-storage.adapter.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { IStorageAdapter, UploadInput, StorageResult } from '../interfaces/storage-adapter.interface';

@Injectable()
export class S3StorageAdapter implements IStorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private config: ConfigService) {
    this.bucket = config.get('storage.s3.bucket');

    this.client = new S3Client({
      region: config.get('storage.s3.region', 'us-east-1'),
      endpoint: config.get('storage.s3.endpoint'), // For MinIO
      credentials: {
        accessKeyId: config.get('storage.s3.accessKeyId'),
        secretAccessKey: config.get('storage.s3.secretAccessKey'),
      },
      forcePathStyle: config.get('storage.s3.forcePathStyle', false), // true for MinIO
    });
  }

  async upload(input: UploadInput): Promise<StorageResult> {
    const folder = input.folder || 'uploads';
    const key = `${folder}/${Date.now()}-${input.filename}`;

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: input.buffer,
      ContentType: input.mimetype,
    }));

    const url = await this.getUrl(key);

    return {
      key,
      url,
      size: input.buffer.length,
      mimetype: input.mimetype,
    };
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));

    return Buffer.from(await response.Body!.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }

  async getUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch {
      return false;
    }
  }
}
```

#### Storage Factory

```typescript
// storage/storage.factory.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IStorageAdapter } from './interfaces/storage-adapter.interface';
import { LocalStorageAdapter } from './adapters/local-storage.adapter';
import { S3StorageAdapter } from './adapters/s3-storage.adapter';

export type StorageType = 'local' | 's3' | 'minio';

@Injectable()
export class StorageFactory {
  constructor(private config: ConfigService) {}

  create(type?: StorageType): IStorageAdapter {
    const storageType = type || this.config.get<StorageType>('storage.type', 'local');

    switch (storageType) {
      case 'local':
        return new LocalStorageAdapter(this.config);

      case 's3':
      case 'minio':
        return new S3StorageAdapter(this.config);

      default:
        throw new Error(`Unknown storage type: ${storageType}`);
    }
  }
}
```

### 3.13.2 Database Adapter

OpenWA supports SQLite for lightweight deployments and PostgreSQL for high-volume production.

#### Database Comparison

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| **Setup** | Zero config | Requires server |
| **Concurrent writes** | Limited (1 writer) | Excellent |
| **Horizontal scaling** | ❌ | ✅ |
| **Table partitioning** | ❌ | ✅ |
| **Memory footprint** | ~10MB | ~100MB+ |
| **Backup** | Copy file | pg_dump |
| **Best for** | 1-5 sessions | 5+ sessions |

#### TypeORM Configuration

```typescript
// config/database.config.ts
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const getDatabaseConfig = (config: ConfigService): TypeOrmModuleOptions => {
  const dbType = config.get<'sqlite' | 'postgres'>('database.type', 'sqlite');

  const baseConfig = {
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
    synchronize: false,
    logging: config.get('database.logging', false),
  };

  if (dbType === 'sqlite') {
    return {
      ...baseConfig,
      type: 'sqlite',
      database: config.get('database.sqlite.path', './data/openwa.db'),
      // SQLite specific optimizations
      extra: {
        // Enable WAL mode for better concurrent reads
        PRAGMA: 'journal_mode = WAL',
      },
    };
  }

  // PostgreSQL
  return {
    ...baseConfig,
    type: 'postgres',
    url: config.get('database.url'),
    ssl: config.get('database.ssl', false)
      ? { rejectUnauthorized: false }
      : false,
    extra: {
      max: config.get('database.pool.max', 20),
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    },
  };
};
```

#### SQLite Considerations

```typescript
// database/sqlite-optimizations.ts

/**
 * SQLite-specific optimizations and limitations
 */
export const SQLITE_CONFIG = {
  // Recommendations
  maxConcurrentSessions: 5,
  maxMessagesBeforeCleanup: 100000,

  // Auto-cleanup settings (no partitioning available)
  messageRetentionDays: 30,
  logRetentionDays: 7,

  // Write queue to avoid SQLITE_BUSY
  enableWriteQueue: true,
  writeQueueConcurrency: 1,
};

/**
 * Middleware for SQLite write serialization
 */
@Injectable()
export class SqliteWriteQueueService {
  private writeQueue = new PQueue({ concurrency: 1 });

  async executeWrite<T>(operation: () => Promise<T>): Promise<T> {
    return this.writeQueue.add(operation);
  }
}
```

#### Migration Strategy

```typescript
// database/migrations/utils/database-aware-migration.ts

/**
 * Helper for writing migrations compatible with SQLite and PostgreSQL
 */
export abstract class DatabaseAwareMigration {
  protected isPostgres(queryRunner: QueryRunner): boolean {
    return queryRunner.connection.options.type === 'postgres';
  }

  protected isSqlite(queryRunner: QueryRunner): boolean {
    return queryRunner.connection.options.type === 'sqlite';
  }

  /**
   * Generate UUID default based on database type
   */
  protected getUuidDefault(queryRunner: QueryRunner): string {
    if (this.isPostgres(queryRunner)) {
      return 'gen_random_uuid()';
    }
    // SQLite: UUID must be generated at the application level
    return '';
  }

  /**
   * Get timestamp type based on database
   */
  protected getTimestampType(queryRunner: QueryRunner): string {
    if (this.isPostgres(queryRunner)) {
      return 'TIMESTAMP WITH TIME ZONE';
    }
    return 'DATETIME';
  }
}
```

### 3.13.3 Cache Adapter

For minimal deployments, in-memory cache is sufficient. For multi-instance deployments, Redis is required.

```typescript
// cache/cache.factory.ts
import { CacheModuleOptions } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { redisStore } from 'cache-manager-redis-store';

export const getCacheConfig = async (
  config: ConfigService
): Promise<CacheModuleOptions> => {
  const cacheType = config.get<'memory' | 'redis'>('cache.type', 'memory');

  if (cacheType === 'memory') {
    return {
      ttl: config.get('cache.ttl', 300) * 1000,
      max: config.get('cache.max', 1000),
    };
  }

  // Redis
  return {
    store: await redisStore({
      url: config.get('redis.url'),
      ttl: config.get('cache.ttl', 300),
    }),
  };
};
```

### 3.13.4 Deployment Profiles

OpenWA provides several deployment profiles for different needs:

```mermaid
flowchart LR
    subgraph Minimal["🪶 Minimal Profile"]
        M1[SQLite]
        M2[Local Storage]
        M3[In-Memory Cache]
        M4[Single Session]
    end

    subgraph Standard["⚡ Standard Profile"]
        S1[PostgreSQL]
        S2[Local Storage]
        S3[Redis]
        S4[Multi Session]
    end

    subgraph Enterprise["🏢 Enterprise Profile"]
        E1[PostgreSQL Cluster]
        E2[S3/MinIO]
        E3[Redis Cluster]
        E4[Horizontal Scaling]
    end
```

| Profile | Database | Storage | Cache | Sessions | RAM | Use Case |
|---------|----------|---------|-------|----------|-----|----------|
| **Minimal** | SQLite | Local | In-Memory | 1-3 | 512MB | Personal bot, testing |
| **Standard** | PostgreSQL | Local | Redis | 5-10 | 2GB | Small business |
| **Enterprise** | PostgreSQL | S3/MinIO | Redis | 10+ | 4GB+ | Agency, high volume |

### Configuration Examples

#### Minimal Profile (.env)

```bash
# Database
DATABASE_TYPE=sqlite
DATABASE_SQLITE_PATH=./data/openwa.db

# Storage
STORAGE_TYPE=local
STORAGE_LOCAL_PATH=./media

# Cache (in-memory, no config needed)
CACHE_TYPE=memory

# Session
MAX_SESSIONS=3

# No Redis needed
# REDIS_URL=
```

#### Standard Profile (.env)

```bash
# Database
DATABASE_TYPE=postgres
DATABASE_URL=postgresql://openwa:password@localhost:5432/openwa

# Storage
STORAGE_TYPE=local
STORAGE_LOCAL_PATH=./media

# Cache
CACHE_TYPE=redis
REDIS_URL=redis://localhost:6379

# Session
MAX_SESSIONS=10
```

#### Enterprise Profile (.env)

```bash
# Database
DATABASE_TYPE=postgres
DATABASE_URL=postgresql://openwa:password@db-cluster:5432/openwa
DATABASE_POOL_MAX=50

# Storage
STORAGE_TYPE=s3
STORAGE_S3_BUCKET=openwa-media
STORAGE_S3_REGION=ap-southeast-1
STORAGE_S3_ACCESS_KEY_ID=xxx
STORAGE_S3_SECRET_ACCESS_KEY=xxx
# For MinIO:
# STORAGE_S3_ENDPOINT=http://minio:9000
# STORAGE_S3_FORCE_PATH_STYLE=true

# Cache
CACHE_TYPE=redis
REDIS_URL=redis://redis-cluster:6379

# Session
MAX_SESSIONS=50

# Scaling
ENABLE_CLUSTER_MODE=true
```

### Auto-Detection & Recommendations

```typescript
// config/profile-detector.ts
import { Logger } from '@nestjs/common';

interface SystemResources {
  totalMemoryMB: number;
  availableMemoryMB: number;
  cpuCores: number;
}

export function detectRecommendedProfile(resources: SystemResources): string {
  const logger = new Logger('ProfileDetector');

  if (resources.totalMemoryMB < 1024) {
    logger.warn('Low memory detected. Using minimal profile.');
    logger.warn('Recommendation: SQLite + Local Storage + In-Memory Cache');
    return 'minimal';
  }

  if (resources.totalMemoryMB < 4096) {
    logger.log('Standard resources detected.');
    logger.log('Recommendation: PostgreSQL + Local Storage + Redis');
    return 'standard';
  }

  logger.log('High resources detected.');
  logger.log('Recommendation: PostgreSQL + S3 + Redis with clustering');
  return 'enterprise';
}
```
---

<div align="center">

[← 02 - Requirements Specification](./02-requirements-specification.md) · [Documentation Index](./README.md) · [Next: 04 - Security Design →](./04-security-design.md)

</div>
