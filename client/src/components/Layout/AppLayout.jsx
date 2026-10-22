import React, { useState } from 'react';
import { Layout, Menu, Dropdown, Avatar, Button, theme } from 'antd';
import {
  DashboardOutlined,
  ProjectOutlined,
  BuildOutlined,
  FileTextOutlined,
  ClusterOutlined,
  DeploymentUnitOutlined,
  UserOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ApiOutlined,
  CloudOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  TableOutlined,
  SyncOutlined,
  OrderedListOutlined,
  CodeOutlined,
  RobotOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { logout } from '../../store/authSlice';
import { authApi } from '../../api/auth';

const { Header, Sider, Content } = Layout;

const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

function AppLayout({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const { user } = useSelector((state) => state.auth);
  const { token: { colorBgContainer } } = theme.useToken();

  const ciPaths = ['/business-projects', '/applications', '/projects', '/deploy-services', '/gitlab', '/registries', '/builds', '/deployments', '/clusters', '/templates'];
  const dbPaths = ['/db-connections', '/table-partition', '/data-sync'];
  const aiPaths = ['/ai-settings', '/ai-chat'];
  const openKeys = [];
  if (ciPaths.includes(location.pathname)) openKeys.push('/ci');
  if (dbPaths.includes(location.pathname)) openKeys.push('/db');
  if (aiPaths.includes(location.pathname)) openKeys.push('/ai');
  const defaultOpenKeys = openKeys;

  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
    {
      key: '/ci',
      icon: <CodeOutlined />,
      label: '持续集成',
      children: [
        { key: '/business-projects', icon: <AppstoreOutlined />, label: '项目管理' },
        { key: '/applications', icon: <ProjectOutlined />, label: '应用管理' },
        { key: '/builds', icon: <BuildOutlined />, label: '构建记录' },
        { key: '/deployments', icon: <DeploymentUnitOutlined />, label: '部署记录' },
        { key: '/gitlab', icon: <ApiOutlined />, label: 'GitLab 连接' },
        { key: '/registries', icon: <CloudOutlined />, label: '远程仓库' },
        { key: '/clusters', icon: <ClusterOutlined />, label: '主机管理' },
        { key: '/templates', icon: <FileTextOutlined />, label: 'Dockerfile 模板' },
      ],
    },
    {
      key: '/db',
      icon: <DatabaseOutlined />,
      label: '数据库管理',
      children: [
        { key: '/db-connections', icon: <ApiOutlined />, label: '数据库连接' },
        { key: '/table-partition', icon: <TableOutlined />, label: '创建分表' },
        { key: '/data-sync', icon: <SyncOutlined />, label: '跨库同步' },
        { key: '/sync-logs', icon: <OrderedListOutlined />, label: '同步日志' },
      ],
    },
    {
      key: '/ai',
      icon: <RobotOutlined />,
      label: '智能能力',
      children: [
        { key: '/ai-chat', icon: <RobotOutlined />, label: 'AI 助手' },
        ...(user?.role === 'admin'
          ? [{ key: '/ai-settings', icon: <SettingOutlined />, label: 'AI 配置' }]
          : []),
      ],
    },
    ...(user?.role === 'admin'
      ? [{ key: '/users', icon: <UserOutlined />, label: '用户管理' }]
      : []),
  ];

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore
    }
    dispatch(logout());
    navigate('/login');
  };

  const userMenuItems = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: `${user?.name || user?.username} (${user?.role})`,
      disabled: true,
    },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: handleLogout },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        width={220}
        style={{
          background: '#fff',
          borderRight: '1px solid #f0f0f0',
        }}
      >
        <div
          style={{
            height: 52,
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: collapsed ? '0 16px' : '0 20px',
            justifyContent: collapsed ? 'center' : 'flex-start',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 2.8 20.4 7.4v9.2L12 21.2 3.6 16.6V7.4L12 2.8Z" stroke="#111" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8.4 9.9h7.2M8.4 12.6h7.2M8.4 15.3h4.3" stroke="#111" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {!collapsed && (
            <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em', color: '#111', fontFamily: FONT }}>DockFlow</span>
          )}
        </div>
        <Menu
          theme="light"
          mode="inline"
          selectedKeys={[location.pathname]}
          defaultOpenKeys={defaultOpenKeys}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ border: 'none', padding: '12px 8px' }}
        />
      </Sider>
      <Layout style={{ background: '#fafafa' }}>
        <Header
          style={{
            padding: '0 24px',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
            height: 52,
            lineHeight: '52px',
          }}
        >
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            style={{ color: '#999' }}
          />
          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: '#666', fontWeight: 300 }}>{user?.name || user?.username}</span>
              <Avatar icon={<UserOutlined />} style={{ backgroundColor: '#111', width: 28, height: 28 }} size="small" />
            </div>
          </Dropdown>
        </Header>
        <Content style={{ padding: '24px 32px', minHeight: 280 }}>
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}

export default AppLayout;
