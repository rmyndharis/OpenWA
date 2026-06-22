export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auto Reply Plugin Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #0b0914;
      --bg-sidebar: #110e22;
      --card-bg: rgba(26, 22, 49, 0.45);
      --card-border: rgba(255, 255, 255, 0.06);
      --text-main: #f1effa;
      --text-muted: #9f9bad;
      --primary: #9b5de5;
      --primary-glow: rgba(155, 93, 229, 0.4);
      --secondary: #00f5d4;
      --accent: #f15bb5;
      --success: #00f5d4;
      --danger: #ff477e;
      --danger-glow: rgba(255, 71, 126, 0.2);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      height: 100%;
      width: 100%;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', sans-serif;
      background-color: var(--bg-dark);
      color: var(--text-main);
      overflow: hidden;
      display: flex;
    }

    /* Background glow decorations */
    .glow-circle {
      position: absolute;
      width: 400px;
      height: 400px;
      border-radius: 50%;
      background: radial-gradient(circle, var(--primary-glow) 0%, rgba(0,0,0,0) 70%);
      filter: blur(80px);
      z-index: -1;
      pointer-events: none;
    }
    .glow-1 { top: -100px; right: -50px; }
    .glow-2 { bottom: -100px; left: -100px; }

    /* App container */
    .app-container {
      display: flex;
      width: 100%;
      height: 100%;
      backdrop-filter: blur(10px);
    }

    /* Sidebar styling */
    aside {
      width: 320px;
      background-color: var(--bg-sidebar);
      border-right: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      height: 100%;
      flex-shrink: 0;
    }

    .sidebar-header {
      padding: 24px;
      border-bottom: 1px solid var(--card-border);
    }

    .sidebar-header h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      font-weight: 800;
      background: linear-gradient(135deg, #b388ff 0%, #80d8ff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .sidebar-header h1 span.badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.1);
      -webkit-text-fill-color: var(--text-main);
      font-weight: 600;
    }

    .session-list {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    .session-item {
      padding: 14px 16px;
      border-radius: 10px;
      background: transparent;
      border: 1px solid transparent;
      cursor: pointer;
      margin-bottom: 10px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .session-item:hover {
      background: rgba(255, 255, 255, 0.03);
      border-color: rgba(255, 255, 255, 0.05);
    }

    .session-item.active {
      background: rgba(155, 93, 229, 0.15);
      border-color: rgba(155, 93, 229, 0.3);
    }

    .session-item .session-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .session-item .session-name {
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      font-size: 15px;
    }

    .session-item .session-status {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-dot.ready { background-color: var(--success); box-shadow: 0 0 8px var(--success); }
    .status-dot.disconnected { background-color: var(--text-muted); }
    .status-dot.failed { background-color: var(--danger); box-shadow: 0 0 8px var(--danger); }

    .session-item .configured-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--secondary);
      box-shadow: 0 0 6px var(--secondary);
    }

    /* Main content workspace */
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    header {
      padding: 20px 32px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header-title {
      min-width: 0;
      flex: 1;
    }

    .header-title h2 {
      font-family: 'Outfit', sans-serif;
      font-size: 22px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .btn-text-mobile {
      display: none;
    }

    .header-actions {
      display: flex;
      gap: 12px;
    }

    /* Button styles */
    .btn {
      padding: 10px 20px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: none;
      transition: all 0.2s ease;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary) 0%, #b388ff 100%);
      color: #fff;
      box-shadow: 0 4px 15px var(--primary-glow);
    }

    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(155, 93, 229, 0.6);
    }

    .btn-danger {
      background: rgba(255, 71, 126, 0.1);
      border: 1px solid rgba(255, 71, 126, 0.2);
      color: var(--danger);
    }

    .btn-danger:hover {
      background: var(--danger);
      color: #fff;
      box-shadow: 0 4px 15px var(--danger-glow);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-main);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    /* Workspace Body */
    .workspace-body {
      flex: 1;
      padding: 32px;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--text-muted);
      gap: 16px;
    }

    .empty-state h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      color: var(--text-main);
    }

    /* Form controls */
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
      max-width: 100%;
    }

    .form-group {
      margin-bottom: 20px;
    }

    .form-group label {
      display: block;
      font-weight: 500;
      margin-bottom: 8px;
      font-size: 14px;
      color: var(--text-main);
    }

    .form-group input[type="text"],
    .form-group textarea {
      width: 100%;
      background: #141223;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 12px 16px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }

    .form-group input[type="text"]:focus,
    .form-group textarea:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 2px var(--primary-glow);
    }

    .form-group textarea {
      resize: vertical;
      min-height: 80px;
    }

    /* Toggle switch */
    .switch-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 20px;
    }

    .switch-info h4 {
      font-family: 'Outfit', sans-serif;
      font-size: 16px;
      margin-bottom: 4px;
    }

    .switch-info p {
      font-size: 12px;
      color: var(--text-muted);
    }

    .switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 24px;
    }

    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: rgba(255, 255, 255, 0.1);
      transition: .4s;
      border-radius: 24px;
    }

    .slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .4s;
      border-radius: 50%;
    }

    input:checked + .slider {
      background-color: var(--primary);
      box-shadow: 0 0 8px var(--primary);
    }

    input:checked + .slider:before {
      transform: translateX(24px);
    }

    /* Option Node Tree Styling */
    .flow-tree-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .flow-tree-header h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 18px;
    }

    .option-node-container {
      margin-top: 16px;
      padding-left: 20px;
      border-left: 2px dashed rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-width: 100%;
    }

    #root-options-container {
      padding-left: 0 !important;
      border-left: none !important;
    }

    .option-node-container:empty {
      display: none !important;
    }

    .option-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 12px;
      padding: 16px;
      position: relative;
      transition: all 0.2s ease;
      max-width: 100%;
    }

    .option-card:hover {
      background: rgba(255, 255, 255, 0.03);
      border-color: rgba(255, 255, 255, 0.08);
    }

    .option-card-header {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
    }

    .option-key-input {
      width: 80px !important;
      font-weight: 600;
      text-align: center;
      background: #141223;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 8px;
      color: var(--secondary);
      outline: none;
    }

    .option-key-input:focus {
      border-color: var(--secondary);
    }

    .option-text-input {
      flex: 1;
      min-width: 0;
      background: #141223;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 8px 12px;
      color: var(--text-main);
      outline: none;
      font-size: 13px;
    }

    .option-actions {
      display: flex;
      gap: 8px;
    }

    .option-btn {
      padding: 8px;
      border-radius: 6px;
      cursor: pointer;
      border: none;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-main);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .option-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .option-btn.delete:hover {
      background: rgba(255, 71, 126, 0.15);
      color: var(--danger);
    }

    /* Toast notification styles */
    .toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .toast {
      background: rgba(20, 18, 33, 0.9);
      border: 1px solid var(--card-border);
      padding: 16px 24px;
      border-radius: 10px;
      color: var(--text-main);
      font-weight: 500;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      gap: 10px;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    .toast.success {
      border-left: 4px solid var(--success);
    }

    .toast.error {
      border-left: 4px solid var(--danger);
    }

    /* Scrollbars */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: rgba(0,0,0,0.1);
    }

    ::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.08);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,0.15);
    }

    @media (max-width: 768px) {
      .app-container {
        flex-direction: column;
      }
      
      .app-container.session-selected aside {
        display: none;
      }
      .app-container:not(.session-selected) main {
        display: none;
      }
      
      aside {
        width: 100% !important;
        height: 100% !important;
        border-right: none;
      }
      
      main {
        width: 100% !important;
        height: 100% !important;
      }

      header {
        padding: 10px 16px !important;
      }
      
      .header-title h2 {
        font-size: 15px !important;
      }
      
      .btn {
        padding: 6px 12px !important;
        font-size: 12px !important;
      }
      
      .workspace-body {
        padding: 10px !important;
      }

      .mobile-back-btn {
        display: inline-flex !important;
      }

      .btn-text-desktop {
        display: none !important;
      }

      .btn-text-mobile {
        display: inline !important;
      }

      .card {
        padding: 10px !important;
        border-radius: 10px !important;
        margin-bottom: 12px !important;
      }

      .option-node-container {
        padding-left: 10px !important;
        margin-top: 10px !important;
        gap: 10px !important;
      }

      .option-card {
        padding: 8px !important;
        border-radius: 6px !important;
      }

      .switch-info h4 {
        font-size: 14px !important;
      }
      
      .switch-info p {
        font-size: 11px !important;
      }

      .form-group label {
        font-size: 13px !important;
        margin-bottom: 6px !important;
      }

      .form-group input[type="text"],
      .form-group textarea {
        font-size: 13px !important;
        padding: 8px 12px !important;
      }

      /* Stack option card controls on mobile using CSS grid */
      .option-card-header {
        display: grid !important;
        grid-template-columns: auto 1fr;
        grid-template-rows: auto auto;
        gap: 8px;
        margin-bottom: 8px;
      }
      
      .option-key-input {
        grid-column: 1;
        grid-row: 1;
        width: 60px !important;
      }
      
      .option-actions {
        grid-column: 2;
        grid-row: 1;
        justify-content: flex-end;
        gap: 8px;
      }
      
      .option-text-input {
        grid-column: 1 / span 2;
        grid-row: 2;
        width: 100% !important;
        min-height: 60px;
      }
    }
  </style>
</head>
<body>
  <div class="glow-circle glow-1"></div>
  <div class="glow-circle glow-2"></div>

  <div class="app-container">
    <!-- Sidebar -->
    <aside>
      <div class="sidebar-header">
        <h1>Auto Reply Flows <span class="badge">v2.0.0</span></h1>
      </div>
      <div class="session-list" id="session-list">
        <div class="empty-state" style="padding-top: 40px;">
          <p style="font-size: 13px;">Loading sessions...</p>
        </div>
      </div>
    </aside>

    <!-- Main Workspace -->
    <main>
      <header>
        <div class="header-title" style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; margin-right: 12px;">
          <button class="btn btn-secondary mobile-back-btn" style="display: none; padding: 6px 10px; font-size: 13px; border-radius: 6px;" onclick="goBackToSessions()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Back
          </button>
          <h2 id="workspace-title">Auto Reply Setup (MaxResellers)</h2>
        </div>
        <div class="header-actions">
          <button class="btn btn-primary" id="btn-save" disabled onclick="saveConfig()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
            <span class="btn-text-desktop">Save Config</span>
            <span class="btn-text-mobile">Save</span>
          </button>
        </div>
      </header>

      <div class="workspace-body" id="workspace-body">
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--primary);"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="9"></line><line x1="9" y1="13" x2="15" y2="13"></line><line x1="9" y1="17" x2="11" y2="17"></line></svg>
          <h3>No Session Selected</h3>
          <p>Please select a session from the sidebar to edit its auto-reply tree-flow configuration.</p>
        </div>
      </div>
    </main>
  </div>

  <div class="toast-container" id="toast-container"></div>

  <script>
    let activeSessionId = null;
    let sessions = [];
    let currentConfig = { sessions: {} };

    // Initialize application
    async function init() {
      await fetchConfig();
      await fetchSessions();
    }

    async function fetchSessions() {
      try {
        const res = await fetch('/plugins/auto-reply/sessions');
        if (!res.ok) throw new Error('Failed to fetch sessions');
        sessions = await res.json();
        renderSessionList();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function fetchConfig() {
      try {
        const res = await fetch('/plugins/auto-reply/config');
        if (!res.ok) throw new Error('Failed to fetch config');
        currentConfig = await res.json();
        if (!currentConfig.sessions) {
          currentConfig.sessions = {};
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function renderSessionList() {
      const container = document.getElementById('session-list');
      if (sessions.length === 0) {
        container.innerHTML = \`
          <div class="empty-state" style="padding-top: 40px;">
            <p style="font-size: 13px;">No active sessions found.</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = sessions.map(session => {
        const hasFlow = currentConfig.sessions[session.id] && currentConfig.sessions[session.id].enabled;
        const isActive = session.id === activeSessionId;
        const statusClass = session.status === 'ready' ? 'ready' : (session.status === 'failed' ? 'failed' : 'disconnected');
        
        return \`
          <div class="session-item \${isActive ? 'active' : ''}" onclick="selectSession('\${session.id}')">
            <div class="session-info">
              <div class="session-name">\${session.name}</div>
              <div class="session-status">
                <span class="status-dot \${statusClass}"></span>
                \${session.status || 'disconnected'}
              </div>
            </div>
            \${hasFlow ? '<span class="configured-indicator" title="Flow Enabled"></span>' : ''}
          </div>
        \`;
      }).join('');
    }

    function selectSession(id) {
      activeSessionId = id;
      document.querySelector('.app-container').classList.add('session-selected');
      renderSessionList();
      loadWorkspace();
      document.getElementById('btn-save').removeAttribute('disabled');
    }

    function goBackToSessions() {
      activeSessionId = null;
      document.querySelector('.app-container').classList.remove('session-selected');
      renderSessionList();
    }

    function loadWorkspace() {
      const container = document.getElementById('workspace-body');
      const session = sessions.find(s => s.id === activeSessionId);
      if (!session) return;

      const titlePrefix = window.innerWidth <= 768 ? "" : "Auto Reply Setup: ";
      document.getElementById('workspace-title').textContent = \`\${titlePrefix}\${session.name}\`;

      // Retrieve or init config
      let flow = currentConfig.sessions[activeSessionId];
      if (!flow) {
        flow = {
          enabled: false,
          trigger: "hi",
          greeting: \`Hello! Welcome to \${session.name}. How can we help you?\\n1. Services\\n2. Support\`,
          options: {
            "1": { text: "We offer top quality hosting and domains." },
            "2": { text: "Contact support at https://support.example.com" }
          }
        };
        currentConfig.sessions[activeSessionId] = flow;
      }

      container.innerHTML = \`
        <!-- Enable switch -->
        <div class="switch-container">
          <div class="switch-info">
            <h4>Enable Auto Reply Flow</h4>
            <p>If active, this session will intercept messages and run the automated reply flow.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="flow-enabled" \${flow.enabled ? 'checked' : ''} onchange="toggleFlowEnabled(this.checked)">
            <span class="slider"></span>
          </label>
        </div>

        <div id="flow-config-panel" style="display: \${flow.enabled ? 'block' : 'none'};">
          <!-- Trigger word -->
          <div class="card">
            <div class="form-group">
              <label for="flow-trigger">Trigger Keyword (e.g. "hi")</label>
              <input type="text" id="flow-trigger" value="\${flow.trigger}" placeholder="Empty triggers on any incoming message" oninput="updateTrigger(this.value)">
              <p style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">Entering "hi" will trigger the flow only when a client says "hi". Leave empty to match *any* inbound message.</p>
            </div>
          </div>

          <!-- Recursive Flow Tree -->
          <div class="card">
            <div class="flow-tree-header">
              <h3>Interactive Greeting & Options</h3>
            </div>
            
            <div class="form-group">
              <label>Initial Greeting / Main Menu Message</label>
              <textarea placeholder="Greeting message text..." oninput="updateGreeting(this.value)">\${flow.greeting}</textarea>
            </div>

            <div class="flow-tree-header" style="margin-top: 24px; border-top: 1px solid var(--card-border); padding-top: 20px;">
              <h4 style="font-family: 'Outfit'; font-size: 15px;">Options Response Tree</h4>
              <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="addOption([])">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                Add Option
              </button>
            </div>

            <div class="option-node-container" id="root-options-container">
              <!-- Rendered recursively -->
            </div>
          </div>
        </div>
      \`;

      renderOptionsTree();
    }

    function toggleFlowEnabled(checked) {
      currentConfig.sessions[activeSessionId].enabled = checked;
      document.getElementById('flow-config-panel').style.display = checked ? 'block' : 'none';
      renderSessionList();
    }

    function updateTrigger(val) {
      currentConfig.sessions[activeSessionId].trigger = val;
    }

    function updateGreeting(val) {
      currentConfig.sessions[activeSessionId].greeting = val;
    }

    // Recursively render options tree DOM
    function renderOptionsTree() {
      const flow = currentConfig.sessions[activeSessionId];
      const container = document.getElementById('root-options-container');
      if (!container) return;

      container.innerHTML = '';
      if (!flow.options || Object.keys(flow.options).length === 0) {
        container.innerHTML = \`<p style="font-size: 13px; color: var(--text-muted); font-style: italic;">No options added. Users will just receive the greeting and flow will end.</p>\`;
        return;
      }

      renderOptionsNode(flow.options, container, []);
    }

    function renderOptionsNode(options, parentContainer, path = []) {
      Object.entries(options).forEach(([key, node]) => {
        const currentPath = [...path, key];
        const card = document.createElement('div');
        card.className = 'option-card';
        
        const hasSuboptions = node.options && Object.keys(node.options).length > 0;

        card.innerHTML = \`
          <div class="option-card-header">
            <input type="text" class="option-key-input" value="\${key}" title="Option code (e.g. 1)" onchange="handleKeyChange('\${path.join(',')}', '\${key}', this.value)">
            <textarea class="option-text-input" placeholder="Response text or sub-menu title..." oninput="handleTextChange('\${currentPath.join(',')}', this.value)">\${node.text || ''}</textarea>
            <div class="option-actions">
              <button class="option-btn" title="Add Sub-options" onclick="addSuboption('\${currentPath.join(',')}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <button class="option-btn delete" title="Delete Option" onclick="deleteNodeOption('\${path.join(',')}', '\${key}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            </div>
          </div>
          <div class="option-node-container" id="container-\${currentPath.join('-')}"></div>
        \`;

        parentContainer.appendChild(card);

        if (hasSuboptions) {
          const subContainer = card.querySelector(\`#container-\${currentPath.join('-')}\`);
          renderOptionsNode(node.options, subContainer, [...path, key, 'options']);
        }
      });
    }

    // Helper functions to get and set nested paths
    function getNodeByPath(pathArr) {
      let flow = currentConfig.sessions[activeSessionId];
      let current = flow;
      
      for (const segment of pathArr) {
        current = current[segment];
      }
      return current;
    }

    function handleTextChange(pathString, val) {
      const pathArr = pathString.split(',');
      const pathArrCopy = [...pathArr];
      const leafSegment = pathArrCopy.pop();
      let node = currentConfig.sessions[activeSessionId].options;
      for (const segment of pathArrCopy) {
        node = node[segment];
      }
      node[leafSegment].text = val;
    }

    function handleKeyChange(parentPathString, oldKey, newKey) {
      newKey = newKey.trim();
      if (newKey === '') {
        showToast('Option key cannot be empty', 'error');
        renderOptionsTree();
        return;
      }
      
      const parentPath = parentPathString === '' ? [] : parentPathString.split(',');
      let targetOptions = currentConfig.sessions[activeSessionId].options;
      
      for (const segment of parentPath) {
        targetOptions = targetOptions[segment];
      }
      
      if (targetOptions[newKey]) {
        showToast(\`Option key "\${newKey}" already exists in this level\`, 'error');
        renderOptionsTree();
        return;
      }

      targetOptions[newKey] = targetOptions[oldKey];
      delete targetOptions[oldKey];
      
      renderOptionsTree();
    }

    function addOption(parentPath) {
      let flow = currentConfig.sessions[activeSessionId];
      if (!flow.options) flow.options = {};
      
      let nextNum = 1;
      while (flow.options[nextNum.toString()]) {
        nextNum++;
      }
      
      flow.options[nextNum.toString()] = { text: "Response details" };
      renderOptionsTree();
    }

    function addSuboption(nodePathString) {
      const pathArr = nodePathString.split(',');
      let node = currentConfig.sessions[activeSessionId].options;
      
      for (const segment of pathArr) {
        node = node[segment];
      }

      if (!node.options) {
        node.options = {};
      }

      let nextNum = 1;
      while (node.options[nextNum.toString()]) {
        nextNum++;
      }

      node.options[nextNum.toString()] = { text: "Nested option response" };
      renderOptionsTree();
    }

    function deleteNodeOption(parentPathString, key) {
      const parentPath = parentPathString === '' ? [] : parentPathString.split(',');
      let targetOptions = currentConfig.sessions[activeSessionId].options;
      
      for (const segment of parentPath) {
        targetOptions = targetOptions[segment];
      }
      
      delete targetOptions[key];
      renderOptionsTree();
    }

    async function saveConfig() {
      const btn = document.getElementById('btn-save');
      btn.setAttribute('disabled', 'true');
      btn.innerHTML = \`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-opacity="0.25" stroke-width="4"></circle><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> <span class="btn-text-desktop">Saving...</span><span class="btn-text-mobile">Saving...</span>\`;

      try {
        const res = await fetch('/plugins/auto-reply/config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(currentConfig)
        });

        if (!res.ok) throw new Error('Save configuration failed');
        showToast('Configuration saved successfully!', 'success');
        
        // Refresh sidebar states
        renderSessionList();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.removeAttribute('disabled');
        btn.innerHTML = \`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> <span class="btn-text-desktop">Save Config</span><span class="btn-text-mobile">Save</span>\`;
      }
    }

    function showToast(message, type = 'success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = \`toast \${type}\`;
      
      const icon = type === 'success' ? '✔️' : '❌';
      toast.innerHTML = \`<span>\${icon}</span> <span>\${message}</span>\`;
      container.appendChild(toast);

      setTimeout(() => toast.classList.add('show'), 10);
      
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
      }, 3000);
    }

    window.onload = init;
  </script>
</body>
</html>
`;
