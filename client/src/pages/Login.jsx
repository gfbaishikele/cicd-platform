import React, { useState } from 'react';
import { Form, Input, Button, message } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { setCredentials } from '../store/authSlice';
import { authApi } from '../api/auth';
import JumpingCat from '../components/JumpingCat';

const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

function Login() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const res = await authApi.login(values);
      const { user, accessToken } = res.data.data;
      dispatch(setCredentials({ user, accessToken }));
      message.success('登录成功');
      navigate('/');
    } catch (err) {
      message.error(err.response?.data?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', fontFamily: FONT, padding: '48px 40px' }}>
      <div style={{ width: '100%', maxWidth: 1060, display: 'grid', gridTemplateColumns: '1fr 1fr', alignItems: 'center', gap: 72 }}>

        {/* 左侧 */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2.8 20.4 7.4v9.2L12 21.2 3.6 16.6V7.4L12 2.8Z" stroke="#111" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M8.4 9.9h7.2M8.4 12.6h7.2M8.4 15.3h4.3" stroke="#111" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: 15, fontWeight: 300, letterSpacing: '-0.01em', color: '#111' }}>DockFlow</span>
          </div>

          {/* SVG 插图 */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '36px 0' }}>
            <svg viewBox="0 0 320 320" fill="none" style={{ width: '100%', maxWidth: 352, height: 'auto', overflow: 'visible' }}>
              <g stroke="#e0e0e0" strokeWidth="1.4" strokeLinecap="round">
                <path d="M22 46V26h20M298 46V26h-20M22 274v20h20M298 274v20h-20" />
              </g>
              <rect x="146" y="70" width="52" height="44" rx="8" stroke="#111" strokeWidth="1.6" fill="#fff" />
              <circle cx="161" cy="86" r="3" fill="#111" />
              <g stroke="#111" strokeWidth="1.4" strokeLinecap="round">
                <path d="M170 86h14M152 100h40M152 106h24" />
              </g>
              <path d="M172 62c0-18 30-18 30 0" stroke="#d8d8d8" strokeWidth="1.4" strokeDasharray="4 6" />
              <g stroke="#111" strokeWidth="1.6">
                <rect x="116" y="126" width="52" height="44" rx="8" fill="#fff" />
                <rect x="176" y="126" width="52" height="44" rx="8" fill="#fff" />
              </g>
              <g stroke="#dcdcdc" strokeWidth="1.4" strokeLinecap="round">
                <path d="M128 144h28M128 152h18" />
                <path d="M188 144h28M188 152h18" />
              </g>
              <g stroke="#111" strokeWidth="1.6">
                <rect x="86" y="182" width="52" height="44" rx="8" fill="#fff" />
                <rect x="146" y="182" width="52" height="44" rx="8" fill="#fff" />
                <rect x="206" y="182" width="52" height="44" rx="8" fill="#111" />
              </g>
              <g stroke="#c9c9c9" strokeWidth="1.4" strokeLinecap="round">
                <path d="M98 200h28M98 208h18" />
                <path d="M158 200h28M158 208h18" />
              </g>
              <g stroke="rgba(255,255,255,.55)" strokeWidth="1.4" strokeLinecap="round">
                <path d="M218 200h28M218 208h18" />
              </g>
              <rect x="58" y="238" width="204" height="18" rx="9" stroke="#111" strokeWidth="1.6" />
              <path d="M78 256v14M242 256v14" stroke="#111" strokeWidth="1.6" strokeLinecap="round" />
              <g stroke="#e6e6e6" strokeWidth="1.2" strokeDasharray="2 4">
                <path d="M26 148h34M260 148h34" />
                <path d="M26 204h34M260 204h34" />
              </g>
              <JumpingCat />
            </svg>
          </div>

          {/* 底部 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 11.5, color: '#b4b4b4', letterSpacing: '0.01em' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><b style={{ width: 4, height: 4, borderRadius: '50%', background: '#111', display: 'block' }}></b>容器交付平台</span>
            <span>© 2026</span>
          </div>
        </div>

        {/* 右侧表单 */}
        <div style={{ width: '100%', maxWidth: 336, justifySelf: 'center' }}>
          <div style={{ fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#8a8a8a', marginBottom: 18 }}>Sign in</div>
          <h1 style={{ margin: '0 0 10px', fontSize: 30, fontWeight: 300, letterSpacing: '-0.035em', lineHeight: 1.25, color: '#111' }}>欢迎回来</h1>
          <p style={{ margin: '0 0 40px', fontSize: 13.5, fontWeight: 300, color: '#8a8a8a', lineHeight: 1.7 }}>
            登录以继续。首次使用？{' '}
            <Link to="/register" style={{ color: '#111', textDecoration: 'none', borderBottom: '1px solid #d6d6d6', paddingBottom: 1 }}>创建账号</Link>
          </p>

          <Form name="login" onFinish={onFinish} autoComplete="off" layout="vertical">
            <Form.Item label={<span style={{ display: 'block', fontSize: 10.5, fontWeight: 300, letterSpacing: '0.13em', textTransform: 'uppercase', color: '#9c9c9c', marginBottom: 10 }}>用户名</span>} name="username" rules={[{ required: true, message: '请输入用户名' }]} style={{ marginBottom: 26 }}>
              <Input placeholder="输入用户名" bordered={false} style={{ fontSize: 14.5, padding: '0 0 10px', borderBottom: '1px solid #e8e8e8', borderRadius: 0, fontFamily: FONT }} />
            </Form.Item>
            <Form.Item label={<span style={{ display: 'block', fontSize: 10.5, fontWeight: 300, letterSpacing: '0.13em', textTransform: 'uppercase', color: '#9c9c9c', marginBottom: 10 }}>密码</span>} name="password" rules={[{ required: true, message: '请输入密码' }]} style={{ marginBottom: 26 }}>
              <Input.Password placeholder="输入密码" bordered={false} style={{ fontSize: 14.5, padding: '0 0 10px', borderBottom: '1px solid #e8e8e8', borderRadius: 0, fontFamily: FONT }} />
            </Form.Item>
            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" loading={loading} block style={{ height: 46, borderRadius: 999, fontSize: 14, fontWeight: 300, background: '#111', border: 'none', letterSpacing: '0.01em', fontFamily: FONT }}>登录</Button>
            </Form.Item>
          </Form>
        </div>
      </div>
    </div>
  );
}

export default Login;
