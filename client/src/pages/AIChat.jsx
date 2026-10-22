import React, { useEffect, useRef, useState } from 'react';
import { Input, Button, Card, Spin, Tag, Space, Typography, Empty, Tooltip, Upload, message } from 'antd';
import { SendOutlined, RobotOutlined, UserOutlined, ToolOutlined, ReloadOutlined, PictureOutlined, CloseOutlined } from '@ant-design/icons';
import { aiApi } from '../api/ai';
import { useSelector } from 'react-redux';
import { v4 as uuidv4 } from 'uuid';

const { Text } = Typography;

function AIChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(uuidv4());
  const [configLoaded, setConfigLoaded] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [images, setImages] = useState([]); // 图片列表（base64）
  const messagesEndRef = useRef(null);
  const { user: currentUser, accessToken } = useSelector((state) => state.auth);

  // 检查 AI 是否已启用
  useEffect(() => {
    aiApi.getConfig({ page: 1, pageSize: 100 }).then(res => {
      const list = res.data.data.list || [];
      setConfigLoaded(true);
      // 检查是否有启用的配置
      setAiEnabled(list.some(config => config.enabled === 1));
    }).catch(() => {
      setConfigLoaded(true);
    });
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  // 流式输出时实时滚动（监听 content/reasoning 变化）
  useEffect(() => {
    if (loading && messagesEndRef.current) {
      const container = messagesEndRef.current.parentElement;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [messages, loading]);

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && images.length === 0) || loading) return;

    const userMsg = { 
      role: 'user', 
      content: text, 
      images: [...images],
      id: Date.now() 
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setImages([]);
    setLoading(true);

    // 创建 AI 消息占位
    const aiMsgId = Date.now() + 1;
    const aiMsg = {
      role: 'assistant',
      content: '',
      reasoning: '',
      actions: [],
      id: aiMsgId,
    };
    setMessages(prev => [...prev, aiMsg]);

    try {
      // 使用流式 API
      const response = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message: text,
          session_id: sessionId,
          images: images.length > 0 ? images : undefined,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let toolCallBuffer = {}; // 缓冲流式 tool_calls

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // 按行分割，保留最后一个不完整的行
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const jsonStr = trimmed.slice(6).trim();
          if (!jsonStr) continue;
          
          try {
            const data = JSON.parse(jsonStr);
              
              if (data.type === 'reasoning') {
                setMessages(prev => prev.map(m => 
                  m.id === aiMsgId ? { ...m, reasoning: m.reasoning + data.content } : m
                ));
              } else if (data.type === 'content') {
                setMessages(prev => prev.map(m => 
                  m.id === aiMsgId ? { ...m, content: m.content + data.content } : m
                ));
              } else if (data.type === 'tool_calls') {
                // 缓冲流式 tool_calls（data 是数组格式）
                const toolCallsArray = Array.isArray(data.data) ? data.data : [data.data];
                
                for (const tc of toolCallsArray) {
                  if (tc.index !== undefined) {
                    const idx = tc.index;
                    if (!toolCallBuffer[idx]) {
                      toolCallBuffer[idx] = {
                        id: tc.id || '',
                        type: tc.type || 'function',
                        function: {
                          name: tc.function?.name || '',
                          arguments: tc.function?.arguments || '',
                        },
                      };
                    } else {
                      // 累积字段：name/id/type 直接覆盖，arguments 增量拼接
                      if (tc.id) toolCallBuffer[idx].id = tc.id;
                      if (tc.type) toolCallBuffer[idx].type = tc.type;
                      if (tc.function?.name) toolCallBuffer[idx].function.name = tc.function.name;
                      if (tc.function?.arguments !== undefined) {
                        toolCallBuffer[idx].function.arguments += tc.function.arguments;
                      }
                    }
                  }
                }
              } else if (data.type === 'tool_result') {
                setMessages(prev => prev.map(m => 
                  m.id === aiMsgId ? { ...m, actions: [...m.actions, { tool: data.tool, result: data.result }] } : m
                ));
              } else if (data.type === 'error') {
                throw new Error(data.message);
              } else if (data.type === 'done') {
                // 流结束，显示累积的 tool_calls
                if (Object.keys(toolCallBuffer).length > 0) {
                  const toolCalls = Object.values(toolCallBuffer);
                  setMessages(prev => prev.map(m => 
                    m.id === aiMsgId ? { ...m, actions: [...m.actions, ...toolCalls.map(tc => ({ tool: tc.function.name, result: null }))] } : m
                  ));
                }
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
    } catch (err) {
      setMessages(prev => prev.map(m => 
        m.id === aiMsgId 
          ? { ...m, role: 'error', content: err.message || 'AI 对话失败，请检查配置或稍后重试' }
          : m
      ));
    } finally {
      setLoading(false);
    }
  };

  const handleNewSession = () => {
    setSessionId(uuidv4());
    setMessages([]);
    setImages([]);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 处理图片上传
  const handleImageUpload = (file) => {
    // 检查文件类型
    const isImage = file.type.startsWith('image/');
    if (!isImage) {
      message.error('只能上传图片文件！');
      return false;
    }
    
    // 检查文件大小（限制 10MB）
    const isLt10M = file.size / 1024 / 1024 < 10;
    if (!isLt10M) {
      message.error('图片大小不能超过 10MB！');
      return false;
    }

    // 检查图片数量（最多 5 张）
    if (images.length >= 5) {
      message.error('最多只能上传 5 张图片！');
      return false;
    }

    // 读取为 base64
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result.split(',')[1]; // 只保留 base64 部分
      setImages(prev => [...prev, base64]);
    };
    reader.readAsDataURL(file);
    
    return false; // 阻止默认上传行为
  };

  // 移除图片
  const handleRemoveImage = (index) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  // 处理粘贴事件（支持直接粘贴图片）
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          // 复用图片上传逻辑
          if (images.length >= 5) {
            message.error('最多只能上传 5 张图片！');
            return;
          }
          const reader = new FileReader();
          reader.onload = (ev) => {
            const base64 = ev.target.result.split(',')[1];
            setImages(prev => [...prev, base64]);
          };
          reader.readAsDataURL(file);
        }
        break;
      }
    }
  };

  // AI 未启用提示
  if (configLoaded && !aiEnabled) {
    return (
      <div style={{ padding: 24 }}>
        <Card>
          <Empty
            description={
              <div>
                <Text type="secondary">AI 功能尚未启用</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  请联系管理员在系统设置中配置 AI 模型
                </Text>
              </div>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      height: 'calc(100vh - 120px)',
      maxHeight: '100%',
    }}>
      {/* 头部 */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #f0f0f0',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <Space>
          <RobotOutlined style={{ fontSize: 18, color: '#111' }} />
          <Text strong>AI 运维助手</Text>
        </Space>
        <Tooltip title="新对话">
          <Button size="small" icon={<ReloadOutlined />} onClick={handleNewSession} />
        </Tooltip>
      </div>

      {/* 消息列表 */}
      <div style={{ 
        flex: 1, 
        overflow: 'auto', 
        overflowY: 'auto',
        padding: '16px 16px 8px 16px',
        scrollBehavior: 'smooth',
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
            <RobotOutlined style={{ fontSize: 32, marginBottom: 12, display: 'block', color: '#d9d9d9' }} />
            <Text type="secondary">你好，我是 AI 运维助手</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              可以问我构建记录、部署状态、容器信息等
            </Text>
            <div style={{ marginTop: 16 }}>
              <Space direction="vertical" size={8}>
                {['最近构建为什么失败了？', '南京测试环境有哪些节点？', '外呼模块部署了几次？'].map(q => (
                  <Button
                    key={q}
                    size="small"
                    style={{ fontSize: 12 }}
                    onClick={() => { setInput(q); }}
                  >
                    {q}
                  </Button>
                ))}
              </Space>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} style={{
            marginBottom: 16,
            display: 'flex',
            flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
            gap: 8,
          }}>
            <div style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              fontSize: 14,
              backgroundColor: msg.role === 'user' ? '#111' : msg.role === 'error' ? '#ff4d4f' : '#f0f0f0',
              color: msg.role === 'user' ? '#fff' : msg.role === 'error' ? '#fff' : '#666',
            }}>
              {msg.role === 'user' ? <UserOutlined /> : msg.role === 'error' ? '!' : <RobotOutlined />}
            </div>
            <div style={{
              maxWidth: '75%',
              padding: '10px 14px',
              borderRadius: 12,
              backgroundColor: msg.role === 'user' ? '#111' : msg.role === 'error' ? '#fff2f0' : '#f5f5f5',
              color: msg.role === 'user' ? '#fff' : msg.role === 'error' ? '#cf1322' : '#333',
              fontSize: 14,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {/* 推理思考过程 */}
              {msg.reasoning && msg.role === 'assistant' && (
                <div style={{
                  marginBottom: 8,
                  padding: '8px 10px',
                  backgroundColor: 'rgba(0,0,0,0.03)',
                  borderRadius: 6,
                  fontSize: 12,
                  color: '#888',
                  borderLeft: '3px solid #d9d9d9',
                }}>
                  <div style={{ fontWeight: 500, marginBottom: 4, color: '#666' }}>💭 思考过程</div>
                  {msg.reasoning}
                </div>
              )}

              {/* 用户消息的图片 */}
              {msg.images?.length > 0 && (
                <div style={{ 
                  display: 'flex', 
                  gap: 6, 
                  marginBottom: msg.content ? 8 : 0,
                  flexWrap: 'wrap',
                }}>
                  {msg.images.map((img, idx) => (
                    <img
                      key={idx}
                      src={`data:image/jpeg;base64,${img}`}
                      alt={`图片 ${idx + 1}`}
                      style={{ 
                        maxWidth: 200, 
                        maxHeight: 200, 
                        borderRadius: 6,
                        border: msg.role === 'user' ? '1px solid rgba(255,255,255,0.3)' : '1px solid #d9d9d9',
                      }}
                    />
                  ))}
                </div>
              )}

              {msg.content}

              {/* Tool 调用记录 */}
              {msg.actions?.length > 0 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                  {msg.actions.map((action, i) => (
                    <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                      <Tag icon={<ToolOutlined />} style={{ background: '#f5f5f5', border: 'none', color: '#666', fontSize: 11, borderRadius: 4, marginBottom: 2 }}>
                        {action.tool}
                      </Tag>
                      {action.result?.error && (
                        <Text type="danger" style={{ fontSize: 11, marginLeft: 4 }}>
                          {action.result.error}
                        </Text>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backgroundColor: '#f0f0f0', color: '#666', fontSize: 14,
            }}>
              <RobotOutlined />
            </div>
            <div style={{
              padding: '10px 14px', borderRadius: 12, backgroundColor: '#f5f5f5',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Spin size="small" />
              <Text type="secondary" style={{ fontSize: 13 }}>AI 正在思考...</Text>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 */}
      <div style={{
        padding: '12px 12px 20px 12px',
        borderTop: '1px solid #f0f0f0',
        flexShrink: 0,
      }}>
        {/* 图片预览区 */}
        {images.length > 0 && (
          <div style={{ 
            display: 'flex', 
            gap: 8, 
            marginBottom: 8,
            flexWrap: 'wrap',
          }}>
            {images.map((img, idx) => (
              <div key={idx} style={{ position: 'relative', display: 'inline-block' }}>
                <img
                  src={`data:image/jpeg;base64,${img}`}
                  alt={`图片 ${idx + 1}`}
                  style={{ 
                    width: 60, 
                    height: 60, 
                    objectFit: 'cover', 
                    borderRadius: 6,
                    border: '1px solid #d9d9d9',
                  }}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<CloseOutlined />}
                  onClick={() => handleRemoveImage(idx)}
                  style={{
                    position: 'absolute',
                    top: -8,
                    right: -8,
                    backgroundColor: '#fff',
                    borderRadius: '50%',
                    width: 20,
                    height: 20,
                    padding: 0,
                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                  }}
                />
              </div>
            ))}
          </div>
        )}
        
        <div style={{ display: 'flex', gap: 8 }}>
          <Upload
            accept="image/*"
            showUploadList={false}
            beforeUpload={handleImageUpload}
            disabled={loading}
          >
            <Tooltip title="上传图片（最多 5 张）">
              <Button
                icon={<PictureOutlined />}
                disabled={loading || images.length >= 5}
              />
            </Tooltip>
          </Upload>
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={handleKeyPress}
            onPaste={handlePaste}
            placeholder="输入你的问题...（支持 Ctrl+V 粘贴图片）"
            autoSize={{ minRows: 1, maxRows: 4 }}
            style={{ flex: 1, resize: 'none' }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            loading={loading}
            disabled={!input.trim() && images.length === 0}
            style={{ alignSelf: 'flex-end', background: '#111', borderColor: '#111' }}
          />
        </div>
      </div>
    </div>
  );
}

export default AIChat;
