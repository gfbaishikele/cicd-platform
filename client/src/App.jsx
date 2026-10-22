import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { Spin } from 'antd';
import { setCredentials, setUser, logout } from './store/authSlice';
import { authApi } from './api/auth';
import AppLayout from './components/Layout/AppLayout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import GitLabConnections from './pages/GitLabConnections';
import Templates from './pages/Templates';
import Builds from './pages/Builds';
import Registries from './pages/Registries';
import Clusters from './pages/Clusters';
import Deployments from './pages/Deployments';
import DeployServices from './pages/DeployServices';
import BusinessProjects from './pages/BusinessProjects';
import DbConnections from './pages/DbConnections';
import TablePartition from './pages/TablePartition';
import DataSync from './pages/DataSync';
import SyncLogs from './pages/SyncLogs';
import Applications from './pages/Applications';
import AIChat from './pages/AIChat';
import AISettings from './pages/AISettings';

function PrivateRoute({ children }) {
  const { isAuthenticated } = useSelector((state) => state.auth);
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

function AdminRoute({ children }) {
  const { isAuthenticated, user } = useSelector((state) => state.auth);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

function App() {
  const dispatch = useDispatch();
  const { isAuthenticated, user } = useSelector((state) => state.auth);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('accessToken');
      if (token) {
        try {
          const res = await authApi.getMe();
          dispatch(setUser(res.data.data));
        } catch {
          dispatch(logout());
        }
      }
      setLoading(false);
    };
    checkAuth();
  }, [dispatch]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/register" element={isAuthenticated ? <Navigate to="/" replace /> : <Register />} />
      <Route
        path="/*"
        element={
          <PrivateRoute>
            <AppLayout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/applications" element={<Applications />} />
                <Route path="/business-projects" element={<BusinessProjects />} />
                <Route path="/projects" element={<Projects />} />
                <Route path="/projects/:id" element={<ProjectDetail />} />
                <Route path="/builds" element={<Builds />} />
                <Route path="/templates" element={<Templates />} />
                <Route path="/registries" element={<Registries />} />
                <Route path="/clusters" element={<Clusters />} />
                <Route path="/deployments" element={<Deployments />} />
                <Route path="/deploy-services" element={<DeployServices />} />
                <Route path="/db-connections" element={<DbConnections />} />
                <Route path="/table-partition" element={<TablePartition />} />
                <Route path="/data-sync" element={<DataSync />} />
                <Route path="/sync-logs" element={<SyncLogs />} />
                <Route path="/gitlab" element={<GitLabConnections />} />
                <Route path="/ai-chat" element={<AIChat />} />
                <Route
                  path="/users"
                  element={
                    <AdminRoute>
                      <Users />
                    </AdminRoute>
                  }
                />
                <Route
                  path="/ai-settings"
                  element={
                    <AdminRoute>
                      <AISettings />
                    </AdminRoute>
                  }
                />
                <Route path="*" element={<div style={{ padding: 24 }}>页面不存在</div>} />
              </Routes>
            </AppLayout>
          </PrivateRoute>
        }
      />
    </Routes>
  );
}

export default App;
