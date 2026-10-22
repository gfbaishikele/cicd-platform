import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Spin } from 'antd';
import {
  ProjectOutlined,
  BuildOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
} from '@ant-design/icons';
import { projectApi } from '../api/projects';
import { buildApi } from '../api/builds';
import { deploymentApi } from '../api/deployments';
import { clusterApi } from '../api/clusters';
import dayjs from 'dayjs';

const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

const buildStatusMap = {
  pending: { color: '#c7c7c7', label: '等待中' },
  building: { color: '#ff9500', label: '构建中' },
  success: { color: '#34c759', label: '成功' },
  failed: { color: '#ff3b30', label: '失败' },
  cancelled: { color: '#c7c7c7', label: '已取消' },
};

const deployStatusMap = {
  pending: { color: '#c7c7c7', label: '等待中' },
  deploying: { color: '#ff9500', label: '部署中' },
  success: { color: '#34c759', label: '成功' },
  failed: { color: '#ff3b30', label: '失败' },
  rolled_back: { color: '#ff9500', label: '已回滚' },
};

function StatusDot({ status }) {
  const map = { ...buildStatusMap, ...deployStatusMap };
  const cfg = map[status] || { color: '#c7c7c7', label: status };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 300, color: '#666' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
      {cfg.label}
    </span>
  );
}

function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    projectCount: 0,
    todayBuilds: 0,
    successRate: 0,
    onlineNodes: 0,
    totalNodes: 0,
  });
  const [recentBuilds, setRecentBuilds] = useState([]);
  const [recentDeploys, setRecentDeploys] = useState([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [projRes, buildRes, nodeRes, deployRes] = await Promise.all([
          projectApi.getList({ pageSize: 1 }).catch(() => ({ data: { data: { total: 0 } } })),
          buildApi.getList({ pageSize: 50 }).catch(() => ({ data: { data: { list: [] } } })),
          clusterApi.getNodes().catch(() => ({ data: { data: [] } })),
          deploymentApi.getList({ pageSize: 5 }).catch(() => ({ data: { data: { list: [] } } })),
        ]);

        const projectCount = projRes.data.data.total || 0;
        const builds = buildRes.data.data.list || [];
        const todayStr = dayjs().format('YYYY-MM-DD');
        const todayBuildList = builds.filter(b => dayjs(b.created_at).format('YYYY-MM-DD') === todayStr);
        const todayBuilds = todayBuildList.length;
        const todaySuccess = todayBuildList.filter(b => b.status === 'success').length;
        const successRate = todayBuilds > 0 ? Math.round((todaySuccess / todayBuilds) * 100) : 0;

        const nodes = nodeRes.data.data || [];
        const onlineNodes = nodes.filter(n => n.status === 'online').length;

        setStats({ projectCount, todayBuilds, successRate, onlineNodes, totalNodes: nodes.length });
        setRecentBuilds(builds.slice(0, 5));
        setRecentDeploys(deployRes.data.data.list || []);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <Spin size="large" />
      </div>
    );
  }

  const statCardStyle = {
    borderRadius: 12,
    border: '1px solid #f0f0f0',
    boxShadow: 'none',
  };

  const statLabelStyle = {
    fontSize: 11,
    fontWeight: 400,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#aaa',
    marginBottom: 10,
    fontFamily: FONT,
  };

  const statValueStyle = {
    fontSize: 28,
    fontWeight: 300,
    letterSpacing: '-0.03em',
    color: '#111',
    lineHeight: 1,
    fontFamily: FONT,
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.02em', color: '#111', fontFamily: FONT }}>仪表盘</div>
        <div style={{ fontSize: 13, fontWeight: 300, color: '#999', marginTop: 4, fontFamily: FONT }}>系统概览与最近动态</div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card style={statCardStyle} styles={{ body: { padding: '20px 22px' } }}>
            <div style={statLabelStyle}>项目总数</div>
            <div style={statValueStyle}>{stats.projectCount}</div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card style={statCardStyle} styles={{ body: { padding: '20px 22px' } }}>
            <div style={statLabelStyle}>今日构建</div>
            <div style={statValueStyle}>{stats.todayBuilds}</div>
            <div style={{ fontSize: 11, color: '#bbb', marginTop: 8, fontWeight: 300 }}>成功率 {stats.successRate}%</div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card style={statCardStyle} styles={{ body: { padding: '20px 22px' } }}>
            <div style={statLabelStyle}>构建成功率</div>
            <div style={statValueStyle}>{stats.successRate}<span style={{ fontSize: 14, color: '#bbb', fontWeight: 300, marginLeft: 2 }}>%</span></div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card style={statCardStyle} styles={{ body: { padding: '20px 22px' } }}>
            <div style={statLabelStyle}>在线节点</div>
            <div style={statValueStyle}>{stats.onlineNodes}<span style={{ fontSize: 14, color: '#bbb', fontWeight: 300, marginLeft: 4 }}>/ {stats.totalNodes}</span></div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={24} lg={12}>
          <Card
            title={<span style={{ fontSize: 14, fontWeight: 400, color: '#111' }}>最近构建</span>}
            style={{ borderRadius: 12, border: '1px solid #f0f0f0', boxShadow: 'none' }}
            styles={{ body: { padding: '0' }, header: { borderBottom: '1px solid #f5f5f5', padding: '14px 20px' } }}
          >
            {recentBuilds.length === 0 ? (
              <div style={{ color: '#bbb', textAlign: 'center', padding: 24, fontSize: 13, fontWeight: 300 }}>暂无构建记录</div>
            ) : (
              recentBuilds.map((item) => (
                <div key={item.id} style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    alignItems: 'center',
                    padding: '13px 20px',
                    borderBottom: '1px solid #f5f5f5',
                  }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 400, color: '#111' }}>#{item.id}</span>
                      <span style={{ marginLeft: 8, color: '#333', fontWeight: 300 }}>{item.project_name}</span>
                      <span style={{
                        marginLeft: 8, display: 'inline-block', padding: '1px 6px', borderRadius: 4,
                        fontSize: 11, fontWeight: 400, background: '#f5f5f5', color: '#666',
                      }}>{item.branch}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <StatusDot status={item.status} />
                      <span style={{ color: '#bbb', fontSize: 11, fontWeight: 300, minWidth: 120, textAlign: 'right' }}>
                        {dayjs(item.created_at).format('YYYY-MM-DD HH:mm')}
                      </span>
                    </div>
                  </div>
              ))
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title={<span style={{ fontSize: 14, fontWeight: 400, color: '#111' }}>最近部署</span>}
            style={{ borderRadius: 12, border: '1px solid #f0f0f0', boxShadow: 'none' }}
            styles={{ body: { padding: '0' }, header: { borderBottom: '1px solid #f5f5f5', padding: '14px 20px' } }}
          >
            {recentDeploys.length === 0 ? (
              <div style={{ color: '#bbb', textAlign: 'center', padding: 24, fontSize: 13, fontWeight: 300 }}>暂无部署记录</div>
            ) : (
              recentDeploys.map((item) => (
                <div key={item.id} style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  alignItems: 'center',
                  padding: '13px 20px',
                  borderBottom: '1px solid #f5f5f5',
                }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: 400, color: '#111' }}>#{item.id}</span>
                    <span style={{ marginLeft: 8, color: '#333', fontWeight: 300 }}>{item.project_name}</span>
                    <DeploymentUnitOutlined style={{ marginLeft: 8, color: '#ccc' }} />
                    <span style={{ marginLeft: 4, color: '#bbb', fontSize: 12, fontWeight: 300 }}>{item.node_name}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <StatusDot status={item.status} />
                    <span style={{ color: '#bbb', fontSize: 11, fontWeight: 300, minWidth: 120, textAlign: 'right' }}>
                      {dayjs(item.created_at).format('YYYY-MM-DD HH:mm')}
                    </span>
                  </div>
                </div>
              ))
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}

export default Dashboard;
