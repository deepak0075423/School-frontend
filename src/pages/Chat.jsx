import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import * as chatApi from '../api/chat.api';
import { useAuth } from '../contexts/AuthContext';
import { Spinner, Modal, Button, Confirm, Badge } from '../components/ui/index';
import { connectSocket, getSocket } from '../socket';

const FALLBACK_POLL = 15000;   // slow poll — safety net when socket is down
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const API_ROOT = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');
const fileHref = (u) => (!u ? '#' : u.startsWith('http') ? u : `${API_ROOT}${u.startsWith('/') ? '' : '/'}${u}`);

function fmtTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  if (dt.toDateString() === now.toDateString()) {
    return dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function ChatAvatar({ name, size = 36, type }) {
  const initials = type === 'group' || type === 'broadcast'
    ? (type === 'broadcast' ? '📢' : '👥')
    : (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: 'var(--primary)',
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  );
}

function Attachment({ att }) {
  if (!att) return null;
  const isImage = /^image\//.test(att.fileType || '');
  if (isImage) {
    return (
      <a href={fileHref(att.fileUrl)} target="_blank" rel="noreferrer">
        <img src={fileHref(att.fileUrl)} alt={att.originalName}
          style={{ maxWidth: 220, maxHeight: 220, borderRadius: 8, display: 'block', marginBottom: 4 }} />
      </a>
    );
  }
  return (
    <a href={fileHref(att.fileUrl)} target="_blank" rel="noreferrer"
      style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, textDecoration: 'none' }}>
      <span style={{ fontSize: '1.2rem' }}>📎</span>
      <span style={{ fontSize: '.85rem', textDecoration: 'underline', wordBreak: 'break-all' }}>
        {att.originalName || 'Attachment'}
      </span>
    </a>
  );
}

export default function Chat() {
  const { user } = useAuth();
  const myId = String(user?._id || '');
  const canCreateGroup = ['school_admin', 'teacher'].includes(user?.role);
  const isSchoolAdmin  = user?.role === 'school_admin';

  const [chats, setChats]               = useState([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [activeChat, setActiveChat]     = useState(null);
  const [messages, setMessages]         = useState([]);
  const [msgsLoading, setMsgsLoading]   = useState(false);
  const [hasMore, setHasMore]           = useState(false);
  const [text, setText]                 = useState('');
  const [sending, setSending]           = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // message interaction state
  const [replyTo, setReplyTo]     = useState(null);
  const [editingMsg, setEditing]  = useState(null);
  const [editText, setEditText]   = useState('');
  const [delMsg, setDelMsg]       = useState(null);
  const [emojiFor, setEmojiFor]   = useState(null);
  const [uploading, setUploading] = useState(false);

  // modals
  const [showNewChat, setShowNewChat]   = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showInfo, setShowInfo]         = useState(false);
  const [showSearch, setShowSearch]     = useState(false);
  const [showOversight, setShowOversight] = useState(false);

  // contacts
  const [contacts, setContacts]               = useState([]);
  const [contactQ, setContactQ]               = useState('');
  const [contactsLoading, setContactsLoading] = useState(false);

  // group creation
  const [groupForm, setGroupForm] = useState({ name: '', description: '', type: 'group', isReadOnly: false });
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupSaving, setGroupSaving]   = useState(false);

  // group info
  const [members, setMembers]         = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [groupEdit, setGroupEdit]     = useState(null);

  // search
  const [searchQ, setSearchQ]           = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // oversight (school_admin)
  const [ovUsers, setOvUsers]     = useState([]);
  const [ovUserQ, setOvUserQ]     = useState('');
  const [ovUser, setOvUser]       = useState(null);
  const [ovChats, setOvChats]     = useState([]);
  const [ovLoading, setOvLoading] = useState(false);

  // typing / presence
  const [typingUsers, setTypingUsers] = useState({});   // chatId → Set(userId)
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const typingTimeoutRef = useRef(null);

  const bottomRef     = useRef(null);
  const listRef       = useRef(null);
  const fileInputRef  = useRef(null);
  const activeChatRef = useRef(null);
  activeChatRef.current = activeChat;

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadChats = useCallback(async () => {
    try {
      const res = await chatApi.getChats();
      setChats(res?.data || []);
    } catch { /* silent */ }
    finally { setChatsLoading(false); }
  }, []);

  useEffect(() => { loadChats(); }, [loadChats]);

  const loadMessages = useCallback(async (chatId, silent = false) => {
    if (!chatId) return;
    if (!silent) setMsgsLoading(true);
    try {
      const res = await chatApi.getMessages(chatId);
      setMessages(res?.data || []);
      setHasMore(!!res?.hasMore);
    } catch { /* silent */ }
    finally { if (!silent) setMsgsLoading(false); }
  }, []);

  const loadOlder = async () => {
    if (!activeChat || !messages.length) return;
    try {
      const res = await chatApi.getMessages(activeChat._id, { before: messages[0].createdAt });
      const older = res?.data || [];
      setMessages(m => [...older, ...m]);
      setHasMore(!!res?.hasMore);
    } catch { /* silent */ }
  };

  // ── Open a chat ───────────────────────────────────────────────────────────
  const openChat = useCallback((chat) => {
    setActiveChat(chat);
    setReplyTo(null); setEditing(null); setEmojiFor(null);
    setChats(cs => cs.map(c => c._id === chat._id ? { ...c, unreadCount: 0 } : c));
    const sock = getSocket();
    if (sock?.connected) sock.emit('chat:read', { chatId: chat._id });
  }, []);

  useEffect(() => {
    if (!activeChat) return;
    loadMessages(activeChat._id);
    const t = setInterval(() => {
      const sock = getSocket();
      if (!sock?.connected && activeChatRef.current?._id) {
        loadMessages(activeChatRef.current._id, true);
      }
    }, FALLBACK_POLL);
    return () => clearInterval(t);
  }, [activeChat?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // ── Socket wiring ─────────────────────────────────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('token');
    const sock = token ? connectSocket(token) : getSocket();
    if (!sock) return;

    const onMessage = (msg) => {
      const chatId = String(msg.chat);
      if (activeChatRef.current && String(activeChatRef.current._id) === chatId) {
        setMessages(m => {
          if (msg.tempId && m.some(x => x._id === msg.tempId)) {
            return m.map(x => (x._id === msg.tempId ? msg : x));
          }
          if (m.some(x => String(x._id) === String(msg._id))) return m;
          return [...m, msg];
        });
        if (String(msg.sender?._id || msg.sender) !== myId) {
          sock.emit('chat:read', { chatId, messageId: msg._id });
        }
      }
      loadChats();
    };

    const onEdited = ({ messageId, content, editedAt }) => {
      setMessages(m => m.map(x => String(x._id) === String(messageId)
        ? { ...x, content, isEdited: true, editedAt } : x));
    };
    const onDeleted = ({ messageId }) => {
      setMessages(m => m.map(x => String(x._id) === String(messageId)
        ? { ...x, isDeleted: true } : x));
    };
    const onReaction = ({ messageId, reactions }) => {
      setMessages(m => m.map(x => String(x._id) === String(messageId) ? { ...x, reactions } : x));
    };
    const onTyping = ({ chatId, userId }) => {
      if (String(userId) === myId) return;
      setTypingUsers(tu => ({ ...tu, [chatId]: [...new Set([...(tu[chatId] || []), String(userId)])] }));
    };
    const onStopTyping = ({ chatId, userId }) => {
      setTypingUsers(tu => ({ ...tu, [chatId]: (tu[chatId] || []).filter(id => id !== String(userId)) }));
    };
    const onOnline  = ({ userId }) => setOnlineUsers(s => new Set([...s, String(userId)]));
    const onOffline = ({ userId }) => setOnlineUsers(s => { const n = new Set(s); n.delete(String(userId)); return n; });
    const onMembership = () => loadChats();
    const onError = ({ message }) => toast.error(message || 'Chat error');

    sock.on('chat:message',          onMessage);
    sock.on('chat:message_edited',   onEdited);
    sock.on('chat:message_deleted',  onDeleted);
    sock.on('chat:reaction',         onReaction);
    sock.on('chat:typing',           onTyping);
    sock.on('chat:stop_typing',      onStopTyping);
    sock.on('chat:user_online',      onOnline);
    sock.on('chat:user_offline',     onOffline);
    sock.on('chat:group_created',    onMembership);
    sock.on('chat:member_added',     onMembership);
    sock.on('chat:member_removed',   onMembership);
    sock.on('chat:group_updated',    onMembership);
    sock.on('chat:error',            onError);

    return () => {
      sock.off('chat:message',         onMessage);
      sock.off('chat:message_edited',  onEdited);
      sock.off('chat:message_deleted', onDeleted);
      sock.off('chat:reaction',        onReaction);
      sock.off('chat:typing',          onTyping);
      sock.off('chat:stop_typing',     onStopTyping);
      sock.off('chat:user_online',     onOnline);
      sock.off('chat:user_offline',    onOffline);
      sock.off('chat:group_created',   onMembership);
      sock.off('chat:member_added',    onMembership);
      sock.off('chat:member_removed',  onMembership);
      sock.off('chat:group_updated',   onMembership);
      sock.off('chat:error',           onError);
    };
  }, [myId, loadChats]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Typing emitter ────────────────────────────────────────────────────────
  const emitTyping = () => {
    const sock = getSocket();
    if (!sock?.connected || !activeChat) return;
    sock.emit('chat:typing', { chatId: activeChat._id });
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      sock.emit('chat:stop_typing', { chatId: activeChat._id });
    }, 2000);
  };

  // ── Send message ──────────────────────────────────────────────────────────
  const doSend = async (payload) => {
    const tempId = `tmp-${Date.now()}`;
    const optimistic = {
      _id: tempId, chat: activeChat._id, sender: { _id: myId, name: user?.name },
      content: payload.content || '', type: payload.type || 'text',
      attachments: payload.attachments || [], replyTo: replyTo || null,
      createdAt: new Date().toISOString(), pending: true,
    };
    setMessages(m => [...m, optimistic]);
    try {
      const res = await chatApi.sendMessage(activeChat._id, { ...payload, replyTo: replyTo?._id || null, tempId });
      setMessages(m => m.map(x => (x._id === tempId ? res.data : x)));
      setReplyTo(null);
      loadChats();
    } catch (err) {
      setMessages(m => m.filter(x => x._id !== tempId));
      toast.error(err?.message || 'Failed to send');
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!text.trim() || !activeChat || sending) return;
    setSending(true);
    const content = text.trim();
    setText('');
    await doSend({ content });
    setSending(false);
  };

  const handleFilePick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !activeChat) return;
    setUploading(true);
    try {
      const res = await chatApi.uploadChatFile(file);
      const { attachment, type } = res.data || {};
      await doSend({ content: '', type, attachments: [attachment] });
    } catch (err) {
      toast.error(err?.message || 'Upload failed');
    } finally { setUploading(false); }
  };

  // ── Message actions ───────────────────────────────────────────────────────
  const startEdit = (msg) => { setEditing(msg); setEditText(msg.content); setEmojiFor(null); };

  const saveEdit = async () => {
    if (!editText.trim()) return;
    try {
      await chatApi.editMessage(editingMsg._id, editText.trim());
      setMessages(m => m.map(x => x._id === editingMsg._id
        ? { ...x, content: editText.trim(), isEdited: true } : x));
      setEditing(null);
    } catch (err) { toast.error(err?.message || 'Failed to edit'); }
  };

  const confirmDelete = async () => {
    try {
      await chatApi.deleteMessage(delMsg._id);
      setMessages(m => m.map(x => x._id === delMsg._id ? { ...x, isDeleted: true } : x));
      setDelMsg(null);
    } catch (err) { toast.error(err?.message || 'Failed to delete'); }
  };

  const react = async (msg, emoji) => {
    setEmojiFor(null);
    try {
      const res = await chatApi.toggleReaction(msg._id, emoji);
      setMessages(m => m.map(x => x._id === msg._id ? { ...x, reactions: res.data } : x));
    } catch (err) { toast.error(err?.message || 'Failed'); }
  };

  // ── Contacts / new chat / new group ───────────────────────────────────────
  const loadContacts = async (q = '') => {
    setContactsLoading(true);
    try {
      const res = await chatApi.getContacts({ q: q || undefined });
      setContacts(res?.data || []);
    } catch { /* silent */ }
    finally { setContactsLoading(false); }
  };

  useEffect(() => {
    if (showNewChat || showNewGroup) loadContacts(contactQ);
  }, [showNewChat, showNewGroup, contactQ]);

  const handleStartChat = async (targetUserId) => {
    try {
      const res = await chatApi.startDirectChat(targetUserId);
      setShowNewChat(false);
      await loadChats();
      const fresh = await chatApi.getChats();
      setChats(fresh?.data || []);
      const found = (fresh?.data || []).find(c => String(c._id) === String(res.data._id));
      openChat(found || res.data);
    } catch (err) {
      toast.error(err?.message || 'Cannot start chat');
    }
  };

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!groupForm.name.trim()) return toast.error('Group name required');
    setGroupSaving(true);
    try {
      const res = await chatApi.createGroup({ ...groupForm, memberIds: groupMembers });
      toast.success('Group created');
      setShowNewGroup(false);
      setGroupForm({ name: '', description: '', type: 'group', isReadOnly: false });
      setGroupMembers([]);
      await loadChats();
      const fresh = await chatApi.getChats();
      const found = (fresh?.data || []).find(c => String(c._id) === String(res.data._id));
      if (found) openChat(found);
    } catch (err) { toast.error(err?.message || 'Failed to create group'); }
    finally { setGroupSaving(false); }
  };

  // ── Group info ────────────────────────────────────────────────────────────
  const openInfo = async () => {
    setShowInfo(true);
    setMembersLoading(true);
    setGroupEdit(null);
    try {
      const res = await chatApi.getChatMembers(activeChat._id);
      setMembers(res?.data || []);
    } catch { /* silent */ }
    finally { setMembersLoading(false); }
  };

  const iAmGroupAdmin = useMemo(
    () => members.some(m => String(m.user?._id) === myId && m.role === 'admin'),
    [members, myId]
  );

  const handleAddMember = async (memberId) => {
    try {
      await chatApi.addMember(activeChat._id, memberId);
      toast.success('Member added');
      const res = await chatApi.getChatMembers(activeChat._id);
      setMembers(res?.data || []);
      setAddingMember(false);
    } catch (err) { toast.error(err?.message || 'Failed'); }
  };

  const handleRemoveMember = async (memberId) => {
    try {
      await chatApi.removeMember(activeChat._id, memberId);
      setMembers(ms => ms.filter(m => String(m.user?._id) !== String(memberId)));
      if (String(memberId) === myId) { setShowInfo(false); setActiveChat(null); loadChats(); }
    } catch (err) { toast.error(err?.message || 'Failed'); }
  };

  const saveGroupSettings = async () => {
    try {
      await chatApi.updateGroupSettings(activeChat._id, groupEdit);
      toast.success('Group updated');
      setActiveChat(c => ({ ...c, ...groupEdit, displayName: groupEdit.name }));
      setGroupEdit(null);
      loadChats();
    } catch (err) { toast.error(err?.message || 'Failed'); }
  };

  const handleMute = async () => {
    try {
      const res = await chatApi.toggleMute(activeChat._id);
      setActiveChat(c => ({ ...c, isMuted: res.data.isMuted }));
      loadChats();
    } catch (err) { toast.error(err?.message || 'Failed'); }
  };

  const handleArchive = async () => {
    try {
      const res = await chatApi.toggleArchive(activeChat._id);
      setActiveChat(c => ({ ...c, isArchived: res.data.isArchived }));
      loadChats();
    } catch (err) { toast.error(err?.message || 'Failed'); }
  };

  // ── Search ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!showSearch || searchQ.trim().length < 2) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await chatApi.searchMessages({ q: searchQ.trim() });
        setSearchResults(res?.data || []);
      } catch { /* silent */ }
      finally { setSearchLoading(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [searchQ, showSearch]);

  // ── Oversight (school_admin) ──────────────────────────────────────────────
  useEffect(() => {
    if (!showOversight) return;
    const t = setTimeout(async () => {
      try {
        const res = await chatApi.getSchoolUsers({ q: ovUserQ || undefined });
        setOvUsers(res?.data || []);
      } catch { /* silent */ }
    }, 300);
    return () => clearTimeout(t);
  }, [showOversight, ovUserQ]);

  const openOvUser = async (u) => {
    setOvUser(u); setOvLoading(true); setOvChats([]);
    try {
      const res = await chatApi.getAdminUserChats(u._id);
      setOvChats(res?.data?.chats || []);
    } catch (err) { toast.error(err?.message || 'Failed'); }
    finally { setOvLoading(false); }
  };

  const openOvChat = async (chat) => {
    setShowOversight(false);
    setActiveChat({ ...chat, observer: true });
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const chatName = (chat) => {
    if (!chat) return '';
    return chat.displayName || chat.name || (chat.type === 'direct' ? 'Direct Chat' : 'Group');
  };

  const visibleChats = chats.filter(c => (showArchived ? c.isArchived : !c.isArchived));
  const activeTyping = (typingUsers[activeChat?._id] || []).length > 0;
  const otherOnline  = activeChat?.type === 'direct' && activeChat?.otherUser &&
                       onlineUsers.has(String(activeChat.otherUser._id));

  const memberNameById = useMemo(() => {
    const map = {};
    members.forEach(m => { if (m.user) map[String(m.user._id)] = m.user.name; });
    return map;
  }, [members]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', height:'calc(100vh - 64px)', overflow:'hidden' }}>

      {/* Sidebar */}
      <div style={{ width:320, borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', flexShrink:0 }}>
        <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
          <strong style={{ fontSize:'1rem' }}>Messages</strong>
          <div style={{ display:'flex', gap:6 }}>
            <button className="btn btn-secondary btn-sm" title="Search messages" onClick={() => { setShowSearch(s => !s); setSearchQ(''); }}>🔍</button>
            {isSchoolAdmin && (
              <button className="btn btn-secondary btn-sm" title="Chat oversight" onClick={() => { setShowOversight(true); setOvUser(null); }}>👁</button>
            )}
            {canCreateGroup && (
              <button className="btn btn-secondary btn-sm" title="New group" onClick={() => setShowNewGroup(true)}>👥+</button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => setShowNewChat(true)}>+ New</button>
          </div>
        </div>

        {showSearch && (
          <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)' }}>
            <input className="form-control" placeholder="Search messages…" autoFocus
              value={searchQ} onChange={e => setSearchQ(e.target.value)} />
          </div>
        )}

        <div ref={listRef} style={{ overflowY:'auto', flex:1 }}>
          {showSearch && searchQ.trim().length >= 2 ? (
            searchLoading ? (
              <div style={{ padding:32, display:'flex', justifyContent:'center' }}><Spinner /></div>
            ) : searchResults.length === 0 ? (
              <div style={{ padding:32, textAlign:'center', color:'var(--text-muted)', fontSize:'.9rem' }}>No messages found</div>
            ) : searchResults.map(msg => (
              <div key={msg._id}
                onClick={() => {
                  const c = chats.find(x => String(x._id) === String(msg.chat?._id || msg.chat));
                  if (c) { setShowSearch(false); openChat(c); }
                }}
                style={{ padding:'10px 16px', cursor:'pointer', borderBottom:'1px solid var(--border)' }}>
                <div style={{ display:'flex', justifyContent:'space-between' }}>
                  <span style={{ fontWeight:600, fontSize:'.85rem' }}>{msg.sender?.name}</span>
                  <span style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{fmtTime(msg.createdAt)}</span>
                </div>
                <div style={{ fontSize:'.82rem', color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {msg.content}
                </div>
                {msg.chat?.name && <Badge variant="muted">{msg.chat.name}</Badge>}
              </div>
            ))
          ) : chatsLoading ? (
            <div style={{ padding:32, display:'flex', justifyContent:'center' }}><Spinner /></div>
          ) : visibleChats.length === 0 ? (
            <div style={{ padding:32, textAlign:'center', color:'var(--text-muted)', fontSize:'.9rem' }}>
              {showArchived ? 'No archived chats.' : <>No chats yet.<br />Start one with "+ New".</>}
            </div>
          ) : visibleChats.map(chat => (
            <div key={chat._id}
              onClick={() => openChat(chat)}
              style={{
                padding:'10px 16px', cursor:'pointer', display:'flex', gap:10, alignItems:'center',
                background: activeChat?._id === chat._id ? 'var(--bg-secondary)' : 'transparent',
                borderBottom:'1px solid var(--border)',
              }}>
              <ChatAvatar name={chatName(chat)} type={chat.type} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontWeight:600, fontSize:'.9rem', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:150 }}>
                    {chat.isMuted && '🔕 '}{chatName(chat)}
                  </span>
                  <span style={{ fontSize:'.72rem', color:'var(--text-muted)', flexShrink:0 }}>{fmtTime(chat.lastActivity)}</span>
                </div>
                <div style={{ fontSize:'.8rem', color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {chat.lastMessage?.isDeleted ? 'Message deleted'
                    : chat.lastMessage?.type === 'image' ? '📷 Photo'
                    : chat.lastMessage?.type === 'file'  ? '📎 File'
                    : chat.lastMessage?.content || 'No messages yet'}
                </div>
              </div>
              {chat.unreadCount > 0 && (
                <div style={{ background:'var(--primary)', color:'#fff', borderRadius:'50%', minWidth:18, height:18, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.7rem', fontWeight:700, flexShrink:0 }}>
                  {chat.unreadCount}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ borderTop:'1px solid var(--border)', padding:'8px 16px' }}>
          <button className="btn btn-secondary btn-sm" style={{ width:'100%' }}
            onClick={() => setShowArchived(a => !a)}>
            {showArchived ? '← Back to chats' : `🗄 Archived (${chats.filter(c => c.isArchived).length})`}
          </button>
        </div>
      </div>

      {/* Message Area */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {!activeChat ? (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'var(--text-muted)' }}>
            <div style={{ fontSize:'2.5rem', marginBottom:12 }}>💬</div>
            <div>Select a conversation or start a new one</div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ padding:'12px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
              <ChatAvatar name={chatName(activeChat)} type={activeChat.type} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700 }}>
                  {chatName(activeChat)}
                  {activeChat.observer && <Badge variant="warning">observer</Badge>}
                  {activeChat.isReadOnly && <span style={{ marginLeft:8 }}><Badge variant="muted">read-only</Badge></span>}
                </div>
                <div style={{ fontSize:'.75rem', color:'var(--text-muted)', textTransform:'capitalize' }}>
                  {activeTyping ? <span style={{ color:'var(--primary)' }}>typing…</span>
                    : otherOnline ? <span style={{ color:'var(--success, #22c55e)' }}>● online</span>
                    : `${activeChat.type} chat`}
                </div>
              </div>
              {!activeChat.observer && (
                <div style={{ display:'flex', gap:6 }}>
                  {(activeChat.type === 'group' || activeChat.type === 'broadcast') && (
                    <button className="btn btn-secondary btn-sm" onClick={openInfo} title="Group info">ℹ️</button>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={handleMute} title={activeChat.isMuted ? 'Unmute' : 'Mute'}>
                    {activeChat.isMuted ? '🔕' : '🔔'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={handleArchive} title={activeChat.isArchived ? 'Unarchive' : 'Archive'}>🗄</button>
                </div>
              )}
            </div>

            {/* Messages */}
            <div style={{ flex:1, overflowY:'auto', padding:'16px 20px', display:'flex', flexDirection:'column', gap:8 }}>
              {msgsLoading ? (
                <div style={{ display:'flex', justifyContent:'center', padding:32 }}><Spinner /></div>
              ) : (
                <>
                  {hasMore && (
                    <div style={{ textAlign:'center' }}>
                      <button className="btn btn-secondary btn-sm" onClick={loadOlder}>Load older messages</button>
                    </div>
                  )}
                  {messages.length === 0 ? (
                    <div style={{ textAlign:'center', color:'var(--text-muted)', marginTop:32 }}>No messages yet. Say hello!</div>
                  ) : messages.map((msg) => {
                    const isMine = String(msg.sender?._id || msg.sender) === myId;
                    const canEdit = isMine && !msg.isDeleted &&
                      (Date.now() - new Date(msg.createdAt).getTime() < 86_400_000);
                    const canDelete = !msg.isDeleted && (isMine || isSchoolAdmin);
                    const isEditing = editingMsg?._id === msg._id;
                    return (
                      <div key={msg._id} style={{ display:'flex', justifyContent: isMine ? 'flex-end' : 'flex-start' }}
                        onMouseLeave={() => setEmojiFor(f => (f === msg._id ? null : f))}>
                        <div style={{ maxWidth:'70%', position:'relative' }}>
                          {!isMine && (
                            <div style={{ fontSize:'.75rem', color:'var(--text-muted)', marginBottom:2, marginLeft:4 }}>
                              {msg.sender?.name}
                              {msg.senderRole && <span style={{ opacity:.7 }}> · {String(msg.senderRole).replace('_',' ')}</span>}
                            </div>
                          )}
                          {msg.replyTo && (
                            <div style={{
                              borderLeft:'3px solid var(--primary)', background:'var(--bg-secondary)',
                              borderRadius:6, padding:'4px 10px', fontSize:'.78rem', marginBottom:2,
                              color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                            }}>
                              <strong>{msg.replyTo.sender?.name || '…'}</strong>{' '}
                              {msg.replyTo.isDeleted ? 'Deleted message' : msg.replyTo.content}
                            </div>
                          )}
                          <div style={{
                            background: isMine ? 'var(--primary)' : 'var(--bg-secondary)',
                            color: isMine ? '#fff' : 'inherit',
                            borderRadius: isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                            padding:'8px 14px',
                            fontSize:'.9rem',
                            wordBreak:'break-word',
                            opacity: msg.isDeleted ? 0.5 : msg.pending ? 0.7 : 1,
                            fontStyle: msg.isDeleted ? 'italic' : 'normal',
                          }}>
                            {msg.isDeleted ? 'This message was deleted' : (
                              <>
                                {(msg.attachments || []).map((att, i) => <Attachment key={i} att={att} />)}
                                {isEditing ? (
                                  <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                                    <input className="form-control" value={editText} autoFocus
                                      onChange={e => setEditText(e.target.value)}
                                      onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null); }}
                                      style={{ fontSize:'.85rem', color:'#111' }} />
                                    <button className="btn btn-sm btn-secondary" onClick={saveEdit}>✓</button>
                                    <button className="btn btn-sm btn-secondary" onClick={() => setEditing(null)}>✕</button>
                                  </div>
                                ) : msg.content}
                              </>
                            )}
                          </div>
                          {(msg.reactions || []).length > 0 && (
                            <div style={{ display:'flex', gap:4, marginTop:2, flexWrap:'wrap', justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
                              {Object.entries((msg.reactions || []).reduce((acc, r) => {
                                acc[r.emoji] = (acc[r.emoji] || 0) + 1; return acc;
                              }, {})).map(([emoji, count]) => (
                                <span key={emoji} onClick={() => !activeChat.observer && react(msg, emoji)}
                                  style={{ background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:12, padding:'1px 7px', fontSize:'.75rem', cursor:'pointer' }}>
                                  {emoji} {count > 1 ? count : ''}
                                </span>
                              ))}
                            </div>
                          )}
                          <div style={{ fontSize:'.7rem', color:'var(--text-muted)', marginTop:2, textAlign: isMine ? 'right' : 'left', marginLeft:4, marginRight:4, display:'flex', gap:8, justifyContent: isMine ? 'flex-end' : 'flex-start', alignItems:'center' }}>
                            <span>{fmtTime(msg.createdAt)}{msg.isEdited && ' · edited'}{msg.pending && ' · sending…'}</span>
                            {!msg.isDeleted && !msg.pending && !activeChat.observer && !isEditing && (
                              <span style={{ display:'flex', gap:6 }}>
                                <span style={{ cursor:'pointer' }} title="React" onClick={() => setEmojiFor(f => f === msg._id ? null : msg._id)}>🙂</span>
                                <span style={{ cursor:'pointer' }} title="Reply" onClick={() => { setReplyTo(msg); setEditing(null); }}>↩</span>
                                {canEdit && <span style={{ cursor:'pointer' }} title="Edit" onClick={() => startEdit(msg)}>✏️</span>}
                                {canDelete && <span style={{ cursor:'pointer' }} title="Delete" onClick={() => setDelMsg(msg)}>🗑</span>}
                              </span>
                            )}
                          </div>
                          {emojiFor === msg._id && (
                            <div style={{
                              position:'absolute', bottom:'100%', [isMine ? 'right' : 'left']: 0, zIndex: 5,
                              background:'var(--bg-primary)', border:'1px solid var(--border)', borderRadius:20,
                              padding:'4px 8px', display:'flex', gap:4, boxShadow:'0 4px 12px rgba(0,0,0,.15)',
                            }}>
                              {EMOJIS.map(e => (
                                <span key={e} style={{ cursor:'pointer', fontSize:'1.1rem' }} onClick={() => react(msg, e)}>{e}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Reply banner */}
            {replyTo && (
              <div style={{ padding:'6px 20px', borderTop:'1px solid var(--border)', background:'var(--bg-secondary)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div style={{ fontSize:'.8rem', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  ↩ Replying to <strong>{replyTo.sender?.name}</strong>: {replyTo.content?.slice(0, 80)}
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setReplyTo(null)}>✕</button>
              </div>
            )}

            {/* Input */}
            {activeChat.observer ? (
              <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', textAlign:'center', color:'var(--text-muted)', fontSize:'.85rem' }}>
                Observer mode — you are viewing this conversation as an administrator.
              </div>
            ) : (activeChat.isReadOnly && !['school_admin', 'teacher'].includes(user?.role)) ? (
              <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', textAlign:'center', color:'var(--text-muted)', fontSize:'.85rem' }}>
                🔒 Only teachers and admins can send messages in this channel.
              </div>
            ) : (
              <form onSubmit={handleSend} style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', gap:8, flexShrink:0 }}>
                <input ref={fileInputRef} type="file" hidden onChange={handleFilePick} />
                <button type="button" className="btn btn-secondary" title="Attach file"
                  onClick={() => fileInputRef.current?.click()} disabled={uploading}
                  style={{ borderRadius:24 }}>
                  {uploading ? '…' : '📎'}
                </button>
                <input
                  className="form-control"
                  placeholder="Type a message…"
                  value={text}
                  onChange={e => { setText(e.target.value); emitTyping(); }}
                  style={{ borderRadius:24 }}
                  disabled={sending}
                />
                <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending} style={{ borderRadius:24, minWidth:72 }}>
                  {sending ? '…' : 'Send'}
                </button>
              </form>
            )}
          </>
        )}
      </div>

      {/* New Direct Chat modal */}
      <Modal open={showNewChat} onClose={() => setShowNewChat(false)} title="New Direct Chat">
        <input className="form-control" placeholder="Search people…" autoFocus
          value={contactQ} onChange={e => setContactQ(e.target.value)} style={{ marginBottom: 12 }} />
        <div style={{ maxHeight: 380, overflowY:'auto' }}>
          {contactsLoading ? (
            <div style={{ padding:32, display:'flex', justifyContent:'center' }}><Spinner /></div>
          ) : contacts.length === 0 ? (
            <div style={{ padding:32, textAlign:'center', color:'var(--text-muted)' }}>No contacts found</div>
          ) : contacts.map(c => (
            <div key={c._id} onClick={() => handleStartChat(c._id)}
              style={{ padding:'10px 12px', cursor:'pointer', display:'flex', gap:10, alignItems:'center', borderBottom:'1px solid var(--border)', borderRadius:6 }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <ChatAvatar name={c.name} size={32} />
              <div>
                <div style={{ fontWeight:600, fontSize:'.9rem' }}>{c.name}</div>
                <div style={{ fontSize:'.75rem', color:'var(--text-muted)', textTransform:'capitalize' }}>{c.role?.replace('_', ' ')}</div>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* New Group modal */}
      <Modal open={showNewGroup} onClose={() => setShowNewGroup(false)} title="Create Group"
        footer={<>
          <Button variant="secondary" onClick={() => setShowNewGroup(false)}>Cancel</Button>
          <Button form="group-form" type="submit" loading={groupSaving}>Create Group</Button>
        </>}>
        <form id="group-form" onSubmit={handleCreateGroup}>
          <div className="form-group">
            <label className="form-label required">Group Name</label>
            <input className="form-control" required value={groupForm.name}
              onChange={e => setGroupForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input className="form-control" value={groupForm.description}
              onChange={e => setGroupForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="form-row form-row-2">
            <div className="form-group">
              <label className="form-label">Type</label>
              <select className="form-control" value={groupForm.type}
                onChange={e => setGroupForm(f => ({ ...f, type: e.target.value }))}>
                <option value="group">Group (everyone can send)</option>
                <option value="broadcast">Broadcast (announcements)</option>
              </select>
            </div>
            <div className="form-group" style={{ display:'flex', alignItems:'flex-end' }}>
              <label style={{ display:'flex', gap:8, alignItems:'center', cursor:'pointer' }}>
                <input type="checkbox" checked={groupForm.isReadOnly}
                  onChange={e => setGroupForm(f => ({ ...f, isReadOnly: e.target.checked }))} />
                Read-only for students/parents
              </label>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Members ({groupMembers.length} selected)</label>
            <input className="form-control" placeholder="Search people…"
              value={contactQ} onChange={e => setContactQ(e.target.value)} style={{ marginBottom: 8 }} />
            <div style={{ maxHeight: 220, overflowY:'auto', border:'1px solid var(--border)', borderRadius:8 }}>
              {contactsLoading ? (
                <div style={{ padding:20, display:'flex', justifyContent:'center' }}><Spinner /></div>
              ) : contacts.map(c => {
                const checked = groupMembers.includes(String(c._id));
                return (
                  <label key={c._id} style={{ padding:'8px 12px', display:'flex', gap:10, alignItems:'center', borderBottom:'1px solid var(--border)', cursor:'pointer' }}>
                    <input type="checkbox" checked={checked}
                      onChange={() => setGroupMembers(ms => checked
                        ? ms.filter(id => id !== String(c._id))
                        : [...ms, String(c._id)])} />
                    <ChatAvatar name={c.name} size={26} />
                    <span style={{ fontSize:'.87rem' }}>{c.name}</span>
                    <span style={{ fontSize:'.72rem', color:'var(--text-muted)', textTransform:'capitalize', marginLeft:'auto' }}>{c.role?.replace('_',' ')}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </form>
      </Modal>

      {/* Group info modal */}
      <Modal open={showInfo} onClose={() => setShowInfo(false)} title={`${chatName(activeChat)} — Info`}>
        {membersLoading ? (
          <div style={{ padding:32, display:'flex', justifyContent:'center' }}><Spinner /></div>
        ) : (
          <>
            {activeChat?.description && (
              <p style={{ color:'var(--text-muted)', fontSize:'.88rem' }}>{activeChat.description}</p>
            )}
            {iAmGroupAdmin && !groupEdit && (
              <div style={{ display:'flex', gap:8, marginBottom:12 }}>
                <Button variant="secondary" size="sm" onClick={() => setGroupEdit({
                  name: activeChat.name || '', description: activeChat.description || '',
                  isReadOnly: !!activeChat.isReadOnly,
                })}>✏️ Edit group</Button>
                <Button variant="secondary" size="sm" onClick={() => { setAddingMember(true); loadContacts(''); }}>＋ Add member</Button>
              </div>
            )}
            {groupEdit && (
              <div style={{ border:'1px solid var(--border)', borderRadius:8, padding:12, marginBottom:12 }}>
                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input className="form-control" value={groupEdit.name}
                    onChange={e => setGroupEdit(g => ({ ...g, name: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Description</label>
                  <input className="form-control" value={groupEdit.description}
                    onChange={e => setGroupEdit(g => ({ ...g, description: e.target.value }))} />
                </div>
                <label style={{ display:'flex', gap:8, alignItems:'center', cursor:'pointer', marginBottom:10 }}>
                  <input type="checkbox" checked={groupEdit.isReadOnly}
                    onChange={e => setGroupEdit(g => ({ ...g, isReadOnly: e.target.checked }))} />
                  Read-only
                </label>
                <div style={{ display:'flex', gap:8 }}>
                  <Button size="sm" onClick={saveGroupSettings}>Save</Button>
                  <Button size="sm" variant="secondary" onClick={() => setGroupEdit(null)}>Cancel</Button>
                </div>
              </div>
            )}
            {addingMember && (
              <div style={{ border:'1px solid var(--border)', borderRadius:8, padding:12, marginBottom:12 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                  <strong style={{ fontSize:'.9rem' }}>Add member</strong>
                  <button className="btn btn-secondary btn-sm" onClick={() => setAddingMember(false)}>✕</button>
                </div>
                <input className="form-control" placeholder="Search people…" value={contactQ}
                  onChange={e => setContactQ(e.target.value)} style={{ marginBottom:8 }} />
                <div style={{ maxHeight:180, overflowY:'auto' }}>
                  {contacts
                    .filter(c => !members.some(m => String(m.user?._id) === String(c._id)))
                    .map(c => (
                      <div key={c._id} onClick={() => handleAddMember(c._id)}
                        style={{ padding:'6px 8px', cursor:'pointer', display:'flex', gap:8, alignItems:'center', borderRadius:6 }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <ChatAvatar name={c.name} size={24} />
                        <span style={{ fontSize:'.85rem' }}>{c.name}</span>
                        <span style={{ fontSize:'.72rem', color:'var(--text-muted)', marginLeft:'auto', textTransform:'capitalize' }}>{c.role?.replace('_',' ')}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
            <div style={{ fontWeight:600, fontSize:'.85rem', marginBottom:6 }}>Members ({members.length})</div>
            <div style={{ maxHeight:280, overflowY:'auto' }}>
              {members.map(m => (
                <div key={m._id} style={{ display:'flex', gap:10, alignItems:'center', padding:'8px 4px', borderBottom:'1px solid var(--border)' }}>
                  <ChatAvatar name={m.user?.name} size={30} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:'.88rem', fontWeight:600 }}>
                      {m.user?.name} {String(m.user?._id) === myId && '(you)'}
                    </div>
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)', textTransform:'capitalize' }}>{m.user?.role?.replace('_',' ')}</div>
                  </div>
                  {m.role === 'admin' && <Badge variant="info">admin</Badge>}
                  {(iAmGroupAdmin || String(m.user?._id) === myId) && members.length > 1 && (
                    <button className="btn btn-danger btn-sm"
                      onClick={() => handleRemoveMember(m.user?._id)}
                      title={String(m.user?._id) === myId ? 'Leave group' : 'Remove'}>
                      {String(m.user?._id) === myId ? 'Leave' : '✕'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      {/* Oversight modal (school_admin) */}
      <Modal open={showOversight} onClose={() => setShowOversight(false)} title="Chat Oversight" maxWidth={640}>
        {!ovUser ? (
          <>
            <input className="form-control" placeholder="Search school users…" autoFocus
              value={ovUserQ} onChange={e => setOvUserQ(e.target.value)} style={{ marginBottom:10 }} />
            <div style={{ maxHeight:380, overflowY:'auto' }}>
              {ovUsers.map(u => (
                <div key={u._id} onClick={() => openOvUser(u)}
                  style={{ padding:'8px 10px', cursor:'pointer', display:'flex', gap:10, alignItems:'center', borderBottom:'1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <ChatAvatar name={u.name} size={30} />
                  <span style={{ fontSize:'.9rem', fontWeight:600 }}>{u.name}</span>
                  <span style={{ fontSize:'.75rem', color:'var(--text-muted)', marginLeft:'auto', textTransform:'capitalize' }}>{u.role?.replace('_',' ')}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setOvUser(null)}>← Back</button>
              <strong>{ovUser.name}</strong>
              <span style={{ fontSize:'.78rem', color:'var(--text-muted)', textTransform:'capitalize' }}>{ovUser.role?.replace('_',' ')}</span>
            </div>
            {ovLoading ? (
              <div style={{ padding:32, display:'flex', justifyContent:'center' }}><Spinner /></div>
            ) : ovChats.length === 0 ? (
              <div style={{ padding:24, textAlign:'center', color:'var(--text-muted)' }}>This user has no chats.</div>
            ) : (
              <div style={{ maxHeight:380, overflowY:'auto' }}>
                {ovChats.map(c => (
                  <div key={c._id} onClick={() => openOvChat(c)}
                    style={{ padding:'8px 10px', cursor:'pointer', display:'flex', gap:10, alignItems:'center', borderBottom:'1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <ChatAvatar name={c.displayName || c.name} size={30} type={c.type} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:'.9rem', fontWeight:600 }}>{c.displayName || c.name || 'Direct chat'}</div>
                      <div style={{ fontSize:'.78rem', color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {c.lastMessage?.content || 'No messages'}
                      </div>
                    </div>
                    <span style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{fmtTime(c.lastActivity)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>

      <Confirm open={!!delMsg} onClose={() => setDelMsg(null)} onConfirm={confirmDelete}
        title="Delete Message" message="Delete this message for everyone?" />
    </div>
  );
}
