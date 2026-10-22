import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { store } from './store';

const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <ConfigProvider
          locale={zhCN}
          theme={{
            token: {
              colorPrimary: '#111111',
              colorLink: '#111111',
              colorInfo: '#111111',
              borderRadius: 8,
              fontFamily: FONT,
              fontWeight: 300,
              fontSize: 13,
              colorBorder: '#f0f0f0',
              colorBorderSecondary: '#f5f5f5',
              colorSplit: '#f0f0f0',
              colorBgLayout: '#fafafa',
              controlHeight: 34,
            },
            components: {
              Button: {
                borderRadius: 999,
                controlHeight: 34,
                fontWeight: 400,
                primaryShadow: 'none',
                defaultShadow: 'none',
              },
              Table: {
                headerBg: '#fafafa',
                headerColor: '#aaa',
                headerSplitColor: 'transparent',
                rowHoverBg: '#fafafa',
                borderColor: '#f5f5f5',
                headerFontSize: 11,
                cellPaddingBlock: 13,
                cellPaddingInline: 16,
              },
              Card: {
                borderRadiusLG: 12,
                boxShadowCard: 'none',
                colorBorderSecondary: '#f0f0f0',
                headerFontSize: 14,
              },
              Menu: {
                itemBg: 'transparent',
                subMenuItemBg: 'transparent',
                itemColor: '#666',
                itemHoverColor: '#111',
                itemSelectedColor: '#111',
                itemSelectedBg: '#f5f5f5',
                itemHoverBg: '#f5f5f5',
                itemBorderRadius: 8,
                itemMarginInline: 8,
                iconSize: 16,
                fontSize: 13,
              },
              Statistic: {
                titleFontSize: 11,
                contentFontSize: 28,
              },
              Tag: {
                borderRadiusSM: 4,
              },
              Input: {
                controlHeight: 34,
                borderRadius: 8,
              },
              Select: {
                controlHeight: 34,
                borderRadius: 8,
              },
              Modal: {
                borderRadiusLG: 12,
              },
            },
          }}
        >
          <App />
        </ConfigProvider>
      </BrowserRouter>
    </Provider>
  </React.StrictMode>
);
