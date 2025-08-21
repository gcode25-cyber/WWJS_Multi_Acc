import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import QRCode from 'qrcode';
import qrImage from 'qr-image';
import { storage } from '../storage';
import fs from 'fs';
import path from 'path';
import type { WebSocket } from 'ws';

export interface WhatsAppSessionInfo {
  sessionId: string;
  number: string;
  name: string;
  loginTime: string;
  status: 'disconnected' | 'connecting' | 'qr_required' | 'connected';
  qrCode?: string;
}

export interface WhatsAppSession {
  sessionId: string;
  client: any;
  info: WhatsAppSessionInfo;
  isReady: boolean;
  isInitializing: boolean;
  qrCode: string | null;
}

export class WhatsAppSessionManager {
  private static instance: WhatsAppSessionManager;
  private sessions: Map<string, WhatsAppSession> = new Map();
  private messageCache: Map<string, any[]> = new Map();

  private constructor() {
    this.restorePreviousSessions();
  }

  public static getInstance(): WhatsAppSessionManager {
    if (!WhatsAppSessionManager.instance) {
      WhatsAppSessionManager.instance = new WhatsAppSessionManager();
    }
    return WhatsAppSessionManager.instance;
  }

  // Helper method to broadcast WebSocket events
  private broadcastToClients(eventType: string, data: any) {
    try {
      const wss = (global as any).wss;
      if (wss && wss.clients) {
        const message = JSON.stringify({ type: eventType, data });
        wss.clients.forEach((client: any) => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(message);
          }
        });
        console.log(`📡 [SessionManager] Broadcasted ${eventType} to ${wss.clients.size} clients`);
      }
    } catch (error) {
      console.error('Failed to broadcast WebSocket message:', error);
    }
  }

  private async restorePreviousSessions() {
    try {
      console.log('🔄 Restoring previous WhatsApp sessions...');
      
      // Check for existing session directories
      const sessionPath = './.wwebjs_auth';
      if (fs.existsSync(sessionPath)) {
        const sessionDirs = fs.readdirSync(sessionPath);
        
        for (const dir of sessionDirs) {
          const fullPath = path.join(sessionPath, dir);
          if (fs.statSync(fullPath).isDirectory()) {
            console.log(`📦 Found session directory: ${dir}`);
            await this.createSession(dir, false); // Don't initialize immediately
          }
        }
      }

      // Also restore from database
      const storedSessions = await storage.getActiveSessions();
      for (const session of storedSessions) {
        if (!this.sessions.has(session.userId)) {
          await this.createSession(session.userId, false);
        }
      }

      console.log(`✅ Restored ${this.sessions.size} WhatsApp sessions`);
    } catch (error: any) {
      console.error('Failed to restore sessions:', error.message);
    }
  }

  public async createSession(sessionId: string, initialize: boolean = true): Promise<WhatsAppSession> {
    if (this.sessions.has(sessionId)) {
      const existingSession = this.sessions.get(sessionId)!;
      if (initialize && !existingSession.isInitializing && !existingSession.isReady) {
        await this.initializeSession(sessionId);
      }
      return existingSession;
    }

    console.log(`🆕 Creating new WhatsApp session: ${sessionId}`);

    const sessionInfo: WhatsAppSessionInfo = {
      sessionId,
      number: '',
      name: '',
      loginTime: '',
      status: 'disconnected',
    };

    const session: WhatsAppSession = {
      sessionId,
      client: null,
      info: sessionInfo,
      isReady: false,
      isInitializing: false,
      qrCode: null,
    };

    this.sessions.set(sessionId, session);

    if (initialize) {
      await this.initializeSession(sessionId);
    }

    // Broadcast session list update
    this.broadcastSessionUpdate();

    return session;
  }

  private async initializeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isInitializing) {
      return;
    }

    session.isInitializing = true;
    session.info.status = 'connecting';
    
    try {
      console.log(`🚀 Initializing WhatsApp session: ${sessionId}`);

      // Check for existing session files
      const sessionPath = path.resolve(`./.wwebjs_auth/${sessionId}`);
      const hasExistingSession = fs.existsSync(sessionPath);

      if (hasExistingSession) {
        console.log(`🔍 Found existing session files for ${sessionId}`);
      } else {
        console.log(`📱 No existing session found for ${sessionId}, will require QR authentication`);
        session.info.status = 'qr_required';
      }

      // Clean up existing client
      if (session.client) {
        try {
          await session.client.destroy();
        } catch (e: any) {
          console.log(`Old client cleanup for ${sessionId}:`, e.message);
        }
        session.client = null;
      }

      // Reset state
      session.qrCode = null;
      session.isReady = false;

      // Create new client
      session.client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: "./.wwebjs_auth"
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-ipc-flooding-protection',
            '--memory-pressure-off',
            '--max_old_space_size=4096',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-pings',
            '--disable-default-apps',
            '--disable-component-extensions-with-background-pages',
            '--force-single-process-tabs',
            '--single-process',
            '--disable-process-per-site',
            '--disable-site-isolation-trials',
            `--user-data-dir=./chrome-user-data-${sessionId}`
          ],
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          timeout: 90000
        }
      });

      // Set up event handlers
      this.setupEventHandlers(sessionId);

      // Initialize client
      await session.client.initialize();
      console.log(`🎯 Session ${sessionId} initialization completed`);

    } catch (error: any) {
      console.error(`❌ Session ${sessionId} initialization failed:`, error.message);
      session.info.status = 'disconnected';
      session.isReady = false;
      session.qrCode = null;
      this.broadcastSessionUpdate();
    } finally {
      session.isInitializing = false;
    }
  }

  private setupEventHandlers(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.client) return;

    const client = session.client;

    client.on('qr', (qr: string) => {
      console.log(`📱 QR Code for session ${sessionId}`);
      session.info.status = 'qr_required';
      
      try {
        const qrStream = qrImage.image(qr, { type: 'png' });
        const chunks: Buffer[] = [];
        
        qrStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        qrStream.on('end', () => {
          const qrBuffer = Buffer.concat(chunks);
          const qrDataURL = 'data:image/png;base64,' + qrBuffer.toString('base64');
          
          session.qrCode = qrDataURL;
          session.info.qrCode = qrDataURL;
          
          // Broadcast QR code to clients
          this.broadcastToClients('account_qr', { 
            sessionId, 
            qr: qrDataURL 
          });
          this.broadcastSessionUpdate();
        });
      } catch (error: any) {
        console.error(`❌ QR generation failed for session ${sessionId}:`, error.message);
      }
    });

    client.on('ready', async () => {
      console.log(`✅ Session ${sessionId} ready`);
      session.isReady = true;
      session.info.status = 'connected';
      
      // Update session info
      session.info.number = client.info?.wid?.user || 'unknown';
      session.info.name = client.info?.pushname || 'unknown';
      session.info.loginTime = new Date().toISOString();
      session.qrCode = null;
      session.info.qrCode = undefined;

      // Save session to database
      try {
        await storage.saveSession({
          userId: session.info.number,
          userName: session.info.name,
          loginTime: new Date(session.info.loginTime),
          sessionData: JSON.stringify(session.info)
        });
        console.log(`💾 Session ${sessionId} saved to database`);
      } catch (error: any) {
        console.log(`Session save failed for ${sessionId}:`, error.message);
      }

      // Broadcast connection
      this.broadcastToClients('account_connected', { 
        sessionId, 
        info: session.info 
      });
      this.broadcastSessionUpdate();
    });

    client.on('authenticated', () => {
      console.log(`🔐 Session ${sessionId} authenticated`);
    });

    client.on('auth_failure', (msg: any) => {
      console.error(`❌ Authentication failed for session ${sessionId}:`, msg);
      session.isReady = false;
      session.info.status = 'disconnected';
      this.broadcastSessionUpdate();
    });

    client.on('disconnected', (reason: any) => {
      console.log(`🔌 Session ${sessionId} disconnected:`, reason);
      session.isReady = false;
      session.info.status = 'disconnected';
      session.qrCode = null;
      session.info.qrCode = undefined;
      
      this.broadcastToClients('account_disconnected', { 
        sessionId, 
        reason 
      });
      this.broadcastSessionUpdate();
    });

    client.on('message', (message: any) => {
      this.storeRealtimeMessage(sessionId, message);
    });

    client.on('message_create', (message: any) => {
      if (message.fromMe) {
        this.storeRealtimeMessage(sessionId, message);
      }
    });
  }

  private storeRealtimeMessage(sessionId: string, message: any) {
    const chatId = message.from;
    const cacheKey = `${sessionId}_${chatId}`;
    
    if (!this.messageCache.has(cacheKey)) {
      this.messageCache.set(cacheKey, []);
    }
    
    const messages = this.messageCache.get(cacheKey)!;
    messages.unshift(message);
    
    // Keep only last 50 messages per chat
    if (messages.length > 50) {
      messages.splice(50);
    }
    
    // Broadcast new message event
    this.broadcastToClients('new_message', { 
      sessionId, 
      message 
    });
  }

  public async logoutSession(sessionId: string): Promise<void> {
    // Handle legacy session logout
    if (sessionId === 'legacy_session') {
      try {
        const legacyService = (global as any).whatsappService;
        if (legacyService && legacyService.logout) {
          console.log('🔌 Logging out legacy session...');
          await legacyService.logout();
          console.log('✅ Legacy session logged out successfully');
        }
      } catch (error: any) {
        console.warn('Error logging out legacy session:', error.message);
      }
      this.broadcastToClients('account_disconnected', { sessionId });
      this.broadcastSessionUpdate();
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`🔌 Logging out session ${sessionId} (keeping account data)`);

    try {
      if (session.client) {
        await session.client.logout();
        await session.client.destroy();
      }
    } catch (error: any) {
      console.log(`Session logout for ${sessionId}:`, error.message);
    }

    // Update session status to disconnected but keep the session data
    session.client = null;
    session.isReady = false;
    session.isInitializing = false;
    session.qrCode = null;
    session.info.status = 'disconnected';

    // Save disconnected state to database for persistence
    try {
      await storage.saveAccountInfo({
        sessionId: sessionId,
        name: session.info.name || '',
        phone: session.info.number || '',
        status: 'disconnected',
        isActive: true, // Keep active so it shows up, but disconnected
        loginTime: session.info.loginTime ? new Date(session.info.loginTime) : undefined,
        sessionData: JSON.stringify(session.info)
      });
      console.log(`💾 Session ${sessionId} saved as disconnected to database`);
    } catch (error: any) {
      console.warn(`Failed to save disconnected session ${sessionId}:`, error.message);
    }

    // Clear session files but keep session info
    const sessionPath = path.resolve(`./.wwebjs_auth/${sessionId}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    // Clear chrome data
    const chromeDataPath = `./chrome-user-data-${sessionId}`;
    if (fs.existsSync(chromeDataPath)) {
      fs.rmSync(chromeDataPath, { recursive: true, force: true });
    }

    this.broadcastToClients('account_disconnected', { sessionId });
    this.broadcastSessionUpdate();
  }

  public async destroySession(sessionId: string): Promise<void> {
    // Handle legacy session deletion
    if (sessionId === 'legacy_session') {
      try {
        const legacyService = (global as any).whatsappService;
        if (legacyService && legacyService.logout) {
          console.log('🗑️ Completely removing legacy session...');
          await legacyService.logout();
          console.log('✅ Legacy session removed successfully');
        }
      } catch (error: any) {
        console.warn('Error removing legacy session:', error.message);
      }
      this.broadcastToClients('account_removed', { sessionId });
      this.broadcastSessionUpdate();
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`🗑️ Completely destroying session ${sessionId}`);

    try {
      if (session.client) {
        await session.client.logout();
        await session.client.destroy();
      }
    } catch (error: any) {
      console.log(`Session cleanup for ${sessionId}:`, error.message);
    }

    // Clear session files
    const sessionPath = path.resolve(`./.wwebjs_auth/${sessionId}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    // Clear chrome data
    const chromeDataPath = `./chrome-user-data-${sessionId}`;
    if (fs.existsSync(chromeDataPath)) {
      fs.rmSync(chromeDataPath, { recursive: true, force: true });
    }

    this.sessions.delete(sessionId);
    this.messageCache.delete(sessionId);

    // Session is already removed from memory (which is what getAllSessionsInfo() uses)
    // No need to clear database storage since we read from memory

    this.broadcastToClients('account_removed', { sessionId });
    this.broadcastSessionUpdate();
  }

  public async reloginSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    console.log(`🔄 Relogin session ${sessionId}`);

    // Clean up existing client first
    if (session.client) {
      try {
        await session.client.destroy();
      } catch (error: any) {
        console.log(`Client cleanup during relogin for ${sessionId}:`, error.message);
      }
    }

    // Reset session state for relogin
    session.client = null;
    session.isReady = false;
    session.isInitializing = false;
    session.qrCode = null;
    session.info.status = 'qr_required';

    // Clear any existing session files to force fresh QR
    const sessionPath = path.resolve(`./.wwebjs_auth/${sessionId}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    // Initialize the session again to get new QR code
    await this.initializeSession(sessionId);
  }

  public getSession(sessionId: string): WhatsAppSession | undefined {
    return this.sessions.get(sessionId);
  }

  public getAllSessions(): WhatsAppSession[] {
    return Array.from(this.sessions.values());
  }

  public getSessionInfo(sessionId: string): WhatsAppSessionInfo | null {
    const session = this.sessions.get(sessionId);
    return session ? session.info : null;
  }

  public getAllSessionsInfo(): WhatsAppSessionInfo[] {
    // Filter out sessions without proper data, but include sessions that are actively waiting for QR auth
    const sessionInfos = Array.from(this.sessions.values())
      .map(s => s.info)
      .filter(info => {
        // Include connected sessions with valid name and number
        if (info.name && info.number) return true;
        
        // Include sessions that are actively waiting for QR authentication
        if (info.status === 'qr_required' || info.status === 'connecting') return true;
        
        // Include disconnected sessions that have valid name and number (for relogin)
        if (info.status === 'disconnected' && info.name && info.number) return true;
        
        // Filter out other sessions without valid data
        return false;
      });
    
    // Check if there's a legacy WhatsApp service running and include it only if no newer sessions exist for the same account
    try {
      const legacyService = (global as any).whatsappService;
      if (legacyService && legacyService.isReady && legacyService.sessionInfo) {
        const name = legacyService.sessionInfo.name || '';
        const number = legacyService.sessionInfo.number || '';
        
        // Only add if we have valid name and number data (avoid "Unknown Account")
        if (name && number) {
          // Check if there's already a session with the same name/number from the new session manager
          const existingSession = sessionInfos.find(s => 
            (s.name === name && s.number === number) || s.sessionId === 'legacy_session'
          );
          
          if (!existingSession) {
            const legacySession: WhatsAppSessionInfo = {
              sessionId: 'legacy_session',
              number: number,
              name: name,
              loginTime: legacyService.sessionInfo.loginTime || '',
              status: 'connected',
            };
            sessionInfos.unshift(legacySession); // Add at beginning
          }
        }
      }
    } catch (error) {
      // Silently ignore errors accessing legacy service
    }
    
    return sessionInfos;
  }

  public isSessionReady(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? session.isReady : false;
  }

  public getQRCode(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session ? session.qrCode : null;
  }

  private broadcastSessionUpdate() {
    const sessions = this.getAllSessionsInfo();
    this.broadcastToClients('sessions_updated', { sessions });
  }

  // Methods for sending messages through specific sessions
  public async sendMessage(sessionId: string, phoneNumber: string, message: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isReady) {
      throw new Error(`Session ${sessionId} not ready`);
    }

    // Format phone number for WhatsApp
    const formattedNumber = phoneNumber.replace(/[^\d]/g, '') + '@c.us';
    return await session.client.sendMessage(formattedNumber, message);
  }

  public async sendMediaMessage(sessionId: string, phoneNumber: string, message: string, filePath: string, filename: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isReady) {
      throw new Error(`Session ${sessionId} not ready`);
    }

    const media = MessageMedia.fromFilePath(filePath);
    media.filename = filename;
    
    const formattedNumber = phoneNumber.replace(/[^\d]/g, '') + '@c.us';
    return await session.client.sendMessage(formattedNumber, media, { caption: message });
  }

  // Legacy methods for backward compatibility (use primary session)
  public getPrimarySession(): WhatsAppSession | undefined {
    // Return the first connected session or create a default one
    const connectedSessions = Array.from(this.sessions.values()).filter(s => s.isReady);
    if (connectedSessions.length > 0) {
      return connectedSessions[0];
    }

    // If no connected sessions, return the first session or create main_session
    const allSessions = Array.from(this.sessions.values());
    if (allSessions.length > 0) {
      return allSessions[0];
    }

    // Create main session for backward compatibility
    this.createSession('main_session');
    return this.sessions.get('main_session');
  }

  public async getChats(sessionId?: string): Promise<any[]> {
    const session = sessionId ? this.sessions.get(sessionId) : this.getPrimarySession();
    if (!session || !session.isReady) {
      return [];
    }

    const chats = await session.client.getChats();
    return chats.map((chat: any) => ({
      id: chat.id._serialized,
      name: chat.name || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount || 0,
      lastMessage: chat.lastMessage ? {
        body: chat.lastMessage.body,
        timestamp: chat.lastMessage.timestamp,
        fromMe: chat.lastMessage.fromMe
      } : null,
      timestamp: chat.timestamp || 0
    })).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  public async getContacts(sessionId?: string): Promise<any[]> {
    const session = sessionId ? this.sessions.get(sessionId) : this.getPrimarySession();
    if (!session || !session.isReady) {
      return [];
    }

    const contacts = await session.client.getContacts();
    
    // Filter contacts to only show saved contacts from phone's address book
    const filteredContacts = contacts.filter((contact: any) => {
      return contact.isWAContact && 
             contact.name && 
             !contact.id._serialized.includes('@g.us') && // Exclude groups
             !contact.id._serialized.includes('status@broadcast'); // Exclude status broadcasts
    });
    
    return filteredContacts.map((contact: any) => ({
      id: contact.id._serialized,
      name: contact.name || contact.pushname || contact.id.user,
      number: contact.number || contact.id.user,
      isMyContact: contact.isMyContact,
      isWAContact: contact.isWAContact,
      profilePicUrl: null,
      isGroup: contact.isGroup || false
    }));
  }

  public async getGroups(sessionId?: string): Promise<any[]> {
    const session = sessionId ? this.sessions.get(sessionId) : this.getPrimarySession();
    if (!session || !session.isReady) {
      return [];
    }

    const chats = await session.client.getChats();
    return chats
      .filter((chat: any) => chat.isGroup)
      .map((group: any) => ({
        id: group.id._serialized,
        name: group.name,
        isGroup: true,
        unreadCount: group.unreadCount || 0,
        lastMessage: group.lastMessage ? {
          body: group.lastMessage.body,
          timestamp: group.lastMessage.timestamp,
          fromMe: group.lastMessage.fromMe
        } : null,
        timestamp: group.timestamp || 0,
        participants: group.participants || [],
        isAdmin: false,
        onlyAdminsCanMessage: false
      }))
      .sort((a: any, b: any) => b.timestamp - a.timestamp);
  }
}

// Export singleton instance
export const sessionManager = WhatsAppSessionManager.getInstance();