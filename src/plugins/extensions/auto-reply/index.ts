/**
 * Auto-reply reference extension plugin.
 *
 * Demonstrates the Tier-2 capability layer end-to-end: it hooks inbound messages and replies
 * via ctx.messages.reply. Registered DISABLED by default — enable it from the dashboard to try
 * the capability layer live. Replies only to inbound, non-group, engine-originated messages.
 */
import { PluginContext, IPlugin } from '../../../core/plugins';
import { HookContext, HookResult } from '../../../core/hooks';
import { IncomingMessage } from '../../../engine/interfaces/whatsapp-engine.interface';
import { PluginLoaderService } from '../../../core/plugins/plugin-loader.service';
import { FlowEngine } from './flow-engine';
import * as fs from 'fs';
import * as path from 'path';
import { DASHBOARD_HTML } from './dashboard.html';

console.log('[AutoReply] index.ts module loaded');

// Intercept registration to inject configSchema and obtain service references
let globalModuleRef: any = null;
let globalPluginStorageService: any = null;

const originalRegister = PluginLoaderService.prototype.registerBuiltInPlugin;
PluginLoaderService.prototype.registerBuiltInPlugin = function (manifest, instance, config) {
  console.log('[AutoReply] registerBuiltInPlugin called for manifest:', manifest.id);
  if (manifest.id === 'auto-reply') {
    console.log('[AutoReply] Matching manifest id auto-reply found, injecting configSchema');
    manifest.configSchema = {
      type: 'object',
      properties: {
        info: {
          type: 'string',
          title: 'Config URL',
          description: 'To configure multiple sessions, navigate to: http://localhost:2785/plugins/auto-reply/dashboard (replace port if custom)',
          default: 'Go to dashboard link above to edit menus',
        }
      }
    };
    globalModuleRef = (this as any).moduleRef;
    globalPluginStorageService = (this as any).pluginStorage;

    // Verify / inject script into dashboard/index.html for dev mode (Vite server on custom/default port)
    try {
      const moduleRef = (this as any).moduleRef;
      let port = '2785';
      try {
        const { ConfigService } = require('@nestjs/config');
        const configService = moduleRef ? moduleRef.get(ConfigService, { strict: false }) : null;
        port = configService ? String(configService.get('port') || '2785') : (process.env.PORT || '2785');
      } catch (e) {
        port = process.env.PORT || '2785';
      }

      const possibleIndexPaths = [
        path.resolve(__dirname, '..', '..', '..', '..', 'dashboard', 'index.html'),
        path.resolve(__dirname, '..', '..', '..', 'dashboard', 'index.html'),
        path.resolve(__dirname, '..', '..', 'dashboard', 'index.html')
      ];
      let foundIndexPath = '';
      for (const p of possibleIndexPaths) {
        if (fs.existsSync(p)) {
          foundIndexPath = p;
          break;
        }
      }
      if (foundIndexPath) {
        let content = fs.readFileSync(foundIndexPath, 'utf8');
        const scriptRegex = /<script src="http:\/\/localhost:\d+\/plugins\/auto-reply\/inject.js"><\/script>/g;
        const targetScript = `<script src="http://localhost:${port}/plugins/auto-reply/inject.js"></script>`;
        
        if (scriptRegex.test(content)) {
          content = content.replace(scriptRegex, targetScript);
        } else if (!content.includes('/plugins/auto-reply/inject.js')) {
          content = content.replace('</body>', `${targetScript}</body>`);
        }
        fs.writeFileSync(foundIndexPath, content, 'utf8');
        console.log(`[AutoReply] Successfully verified/updated dev inject script in ${foundIndexPath} for port ${port}`);
      }
    } catch (e: any) {
      console.error('[AutoReply] Dev inject script setup failed:', e.message);
    }

    let errCount = 0;
    const interval = setInterval(() => {
      try {
        console.log('[AutoReply] Polling tick...');
        const { HttpAdapterHost } = require('@nestjs/core');
        if (!globalModuleRef) {
          throw new Error('globalModuleRef is not defined');
        }
        const adapterHost = globalModuleRef.get(HttpAdapterHost, { strict: false });
        console.log('[AutoReply] Resolved adapterHost:', !!adapterHost);
        if (adapterHost) {
          const httpAdapter = adapterHost.httpAdapter;
          console.log('[AutoReply] Resolved httpAdapter:', !!httpAdapter);
          if (httpAdapter) {
            const app = httpAdapter.getInstance();
            console.log('[AutoReply] Resolved express app:', !!app);
            if (app) {
              const routerProp = app.router ? 'router' : '_router';
              const routerObj = app[routerProp];
              console.log(`[AutoReply] Resolved routerObj (via app.${routerProp}):`, !!routerObj);
              if (routerObj && Array.isArray(routerObj.stack)) {
                clearInterval(interval);
                setupExpressRoutes(app);
                console.log(`[AutoReply] Custom express routes successfully registered at the front of the Express stack via app.${routerProp}.`);
              }
            }
          }
        }
      } catch (err: any) {
        if (errCount++ < 10) {
          console.error('[AutoReply] Polling error:', err.stack || err.message || err);
        }
      }
    }, 500);
  }
  return originalRegister.call(this, manifest, instance, config);
};

function autoReplyHtmlInjector(req: any, res: any, next: any) {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/socket.io') &&
    !req.path.startsWith('/plugins/auto-reply') &&
    !req.path.includes('.')
  ) {
    try {
      const possiblePaths = [
        path.join(__dirname, '..', '..', '..', 'dashboard', 'dist', 'index.html'),
        path.resolve(__dirname, '..', 'dashboard', 'dist', 'index.html'),
        path.resolve(__dirname, '../../dashboard/dist/index.html'),
        path.resolve(__dirname, '../../../dashboard/dist/index.html'),
        path.resolve(__dirname, '../../../../dashboard/dist/index.html')
      ];
      let foundPath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          foundPath = p;
          break;
        }
      }
      if (foundPath) {
        let html = fs.readFileSync(foundPath, 'utf8');
        if (!html.includes('/plugins/auto-reply/inject.js')) {
          html = html.replace(/<\/body>/i, '<script src="/plugins/auto-reply/inject.js"></script></body>');
        }
        res.setHeader('Content-Type', 'text/html');
        return res.send(html);
      }
    } catch (err) {
      console.error('[AutoReply] Failed to inject index.html:', err);
    }
  }
  next();
}

function setupExpressRoutes(app: any) {
  const express = require('express');
  const jsonParser = express.json({ limit: '25mb' });

  // Use the HTML injector middleware
  app.use(autoReplyHtmlInjector);

  // Serve the dynamic javascript file that intercepts modal loading in the dashboard
  app.get('/plugins/auto-reply/inject.js', (req: any, res: any) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
(function() {
  console.log('[AutoReply] inject.js loaded');

  // Determine the backend origin dynamically from this script's src tag
  const scriptSrc = document.currentScript ? document.currentScript.src : '';
  const backendOrigin = scriptSrc ? new URL(scriptSrc).origin : window.location.origin;

  function runEnforcer() {
    const modal = document.querySelector('.config-modal');
    if (!modal) return;
    
    const header = modal.querySelector('.modal-header h2');
    if (header && (header.textContent.includes('Auto Reply') || header.textContent.includes('auto-reply'))) {
      // 1. Enforce wide-modal styles directly in JS to override all CSS constraints
      if (!modal.classList.contains('wide-modal')) {
        modal.classList.add('wide-modal');
      }
      modal.style.maxWidth = '1200px';
      modal.style.width = '95vw';
      modal.style.height = '90vh';
      modal.style.display = 'flex';
      modal.style.flexDirection = 'column';
      
      // 2. Enforce iframe inside modal-body and style modal-body
      const modalBody = modal.querySelector('.modal-body');
      if (modalBody) {
        modalBody.style.flex = '1';
        modalBody.style.padding = '0';
        modalBody.style.overflow = 'hidden';
        modalBody.style.height = '100%';

        const iframe = modalBody.querySelector('iframe');
        if (!iframe || !iframe.src.includes('/plugins/auto-reply/dashboard')) {
          modalBody.innerHTML = '';
          const newIframe = document.createElement('iframe');
          newIframe.src = backendOrigin + '/plugins/auto-reply/dashboard';
          newIframe.style.width = '100%';
          newIframe.style.height = '100%';
          newIframe.style.border = 'none';
          newIframe.style.background = 'transparent';
          modalBody.appendChild(newIframe);
        }
      }
      
      // 3. Enforce hidden footer
      const modalFooter = modal.querySelector('.modal-footer');
      if (modalFooter && modalFooter.style.display !== 'none') {
        modalFooter.style.display = 'none';
      }
    }
  }

  // Check immediately
  runEnforcer();

  // Set up MutationObserver to watch for dynamic modal updates/insertions and attribute resets
  const observer = new MutationObserver((mutations) => {
    runEnforcer();
  });

  observer.observe(document.body, { 
    childList: true, 
    subtree: true, 
    attributes: true,
    attributeFilter: ['class', 'style']
  });
})();
    `);
  });

  app.get('/plugins/auto-reply/dashboard', (req: any, res: any) => {
    try {
      res.setHeader('Content-Type', 'text/html');
      res.send(DASHBOARD_HTML);
    } catch (err: any) {
      res.status(500).send(`Failed to load dashboard: ${err.message}`);
    }
  });

  app.get('/plugins/auto-reply/sessions', async (req: any, res: any) => {
    try {
      const { SessionService } = require('../../../modules/session/session.service');
      const sessionService = globalModuleRef.get(SessionService, { strict: false });
      const sessions = await sessionService.findAll();
      res.json(sessions.map((s: any) => ({ id: s.id, name: s.name, status: s.status })));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/plugins/auto-reply/config', async (req: any, res: any) => {
    try {
      const storage = globalPluginStorageService.createPluginStorage('auto-reply');
      const config = await storage.get('config');
      res.json(config || { sessions: {} });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/plugins/auto-reply/config', jsonParser, async (req: any, res: any) => {
    try {
      const storage = globalPluginStorageService.createPluginStorage('auto-reply');
      await storage.set('config', req.body);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Move our custom routes to the absolute beginning of the Express middleware/route stack.
  // This ensures they are matched and handled before NestJS's router or wildcard handlers catch them.
  const routerProp = app.router ? 'router' : '_router';
  const routerObj = app[routerProp];
  if (routerObj && Array.isArray(routerObj.stack)) {
    const stack = routerObj.stack;
    const ourPaths = [
      '/plugins/auto-reply/dashboard',
      '/plugins/auto-reply/sessions',
      '/plugins/auto-reply/config',
      '/plugins/auto-reply/inject.js'
    ];
    
    const ourLayers: any[] = [];
    const otherLayers: any[] = [];
    
    for (const layer of stack) {
      const isOurPath = layer && layer.route && layer.route.path && ourPaths.includes(layer.route.path);
      const isOurMiddleware = layer && layer.name === 'autoReplyHtmlInjector';
      if (isOurPath || isOurMiddleware) {
        ourLayers.push(layer);
      } else {
        otherLayers.push(layer);
      }
    }
    
    // Prepend our layers to the stack
    routerObj.stack = [...ourLayers, ...otherLayers];
  }
}

export class AutoReplyPlugin implements IPlugin {
  onEnable(context: PluginContext): Promise<void> {
    context.registerHook('message:received', ctx => this.onMessage(context, ctx as HookContext<IncomingMessage>));
    context.logger.log('Auto-reply reference plugin enabled');
    return Promise.resolve();
  }

  private async onMessage(context: PluginContext, ctx: HookContext<IncomingMessage>): Promise<HookResult> {
    const message = ctx.data;

    // Reply only to inbound, non-group, engine-originated messages; never to our own sends.
    if (ctx.source !== 'Engine' || !ctx.sessionId || message.fromMe || message.isGroup) {
      return { continue: true };
    }

    try {
      await FlowEngine.processMessage(context, ctx.sessionId, message.chatId, message.body || '', message.id);
    } catch (error) {
      context.logger.error('Auto-reply failed', error);
    }

    // Keep the inbound message in history + webhooks + ws (do not swallow).
    return { continue: true };
  }
}

export default AutoReplyPlugin;

