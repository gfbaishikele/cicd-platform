const { body, param, query, validationResult } = require('express-validator');

/**
 * 校验结果处理中间件
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      code: 40003,
      message: '参数校验失败',
      errors: errors.array().map(e => ({
        field: e.path,
        message: e.msg,
      })),
    });
  }
  next();
}

// ============ Auth 校验规则 ============

const registerRules = [
  body('username')
    .isString()
    .trim()
    .isLength({ min: 3, max: 32 })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('用户名只能包含字母、数字和下划线，长度 3-32'),
  body('name')
    .isString()
    .trim()
    .isLength({ min: 1, max: 64 })
    .withMessage('名称长度 1-64 个字符'),
  body('password')
    .isString()
    .isLength({ min: 6, max: 64 })
    .withMessage('密码长度需要 6-64 个字符'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('邮箱格式不正确'),
];

const loginRules = [
  body('username').isString().notEmpty().withMessage('请输入用户名'),
  body('password').isString().notEmpty().withMessage('请输入密码'),
];

// ============ User 校验规则 ============

const updateUserRules = [
  body('role')
    .optional()
    .isIn(['admin', 'user'])
    .withMessage('角色只能是 admin 或 user'),
  body('status')
    .optional()
    .isIn(['active', 'disabled'])
    .withMessage('状态只能是 active 或 disabled'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('邮箱格式不正确'),
  body('name')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 64 })
    .withMessage('名称长度 1-64 个字符'),
];

const updatePasswordRules = [
  body('newPassword')
    .isString()
    .isLength({ min: 6, max: 64 })
    .withMessage('新密码长度需要 6-64 个字符'),
  body('oldPassword')
    .optional()
    .isString()
    .notEmpty(),
];

// ============ GitLab 校验规则 ============

const gitlabConnectionRules = [
  body('name').isString().trim().notEmpty().withMessage('连接名称不能为空'),
  body('url').isURL({ require_protocol: true }).withMessage('请输入有效的 URL'),
  body('token').isString().trim().notEmpty().withMessage('Token 不能为空'),
  body('scope').optional().isIn(['public', 'private']).withMessage('可见性必须是 public 或 private'),
];

// ============ Project 校验规则 ============

const createProjectRules = [
  body('name').isString().trim().notEmpty().withMessage('项目名称不能为空'),
  body('repo_path').isString().trim().notEmpty().withMessage('仓库路径不能为空'),
  body('build_type').isIn(['java', 'vue', 'custom']).withMessage('构建类型只能是 java/vue/custom'),
  body('gitlab_connection_id').optional().isInt().withMessage('GitLab 连接 ID 必须是整数'),
];

// ============ Build 校验规则 ============

const createBuildRules = [
  body('project_id').isInt({ min: 1 }).withMessage('项目 ID 必须为正整数'),
  body('branch').isString().trim().notEmpty().withMessage('分支名不能为空'),
];

// ============ Template 校验规则 ============

const createTemplateRules = [
  body('name').isString().trim().notEmpty().withMessage('模板名称不能为空'),
  body('build_type').isIn(['java', 'vue', 'custom']).withMessage('构建类型不正确'),
  body('content').isString().trim().notEmpty().withMessage('模板内容不能为空'),
];

// ============ Cluster 校验规则 ============

const createNodeRules = [
  body('name').isString().trim().notEmpty().withMessage('节点名称不能为空'),
  body('host').isString().trim().notEmpty().withMessage('主机地址不能为空'),
  body('username').isString().trim().notEmpty().withMessage('用户名不能为空'),
  body('auth_secret').isString().trim().notEmpty().withMessage('认证凭据不能为空'),
  body('auth_type').optional().isIn(['password', 'key']).withMessage('认证类型只能是 password 或 key'),
  body('group_id').optional({ nullable: true }).isInt().withMessage('分组 ID 必须为整数'),
];

// ============ Deployment 校验规则 ============

const createDeploymentRules = [
  body('project_id').isInt({ min: 1 }).withMessage('项目 ID 必须为正整数'),
  body('build_id').isInt({ min: 1 }).withMessage('构建 ID 必须为正整数'),
  body('node_ids').optional().isArray().withMessage('节点 ID 必须为数组'),
  body('group_ids').optional().isArray().withMessage('分组 ID 必须为数组'),
  body('image_tag').isString().trim().notEmpty().withMessage('镜像标签不能为空'),
];

module.exports = {
  validate,
  registerRules,
  loginRules,
  updateUserRules,
  updatePasswordRules,
  gitlabConnectionRules,
  createProjectRules,
  createBuildRules,
  createTemplateRules,
  createNodeRules,
  createDeploymentRules,
};
