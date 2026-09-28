import type { AdminActor } from '../auth/middleware.js';
import type { UserPatch, UserRecord, UserStore } from '../auth/userStore.js';
import type { AdminUserDeps } from '../services/adminUsers.js';
import { describe, expect, it } from 'vitest';
import { removeUser, removeUsers, updateUser, updateUsersStatus } from '../services/adminUsers.js';

const SELF = 1;
const OTHER = 2;
const ACTOR: AdminActor = { userId: SELF, superToken: false };

function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: OTHER,
    username: 'member',
    role: 'user',
    status: 'active',
    createdAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * 假依赖：记录级联清理的调用顺序，用于验证「先清从属数据再删账号」这条约定。
 * activeAdmins 表示库中「可登录」的管理员数量（role 为 admin 且 status 为 active），
 * 供自锁规则判定——被停用的管理员进不了后台，不占这个名额。
 * 批量用例用 targets 按 id 造出多个不同账号，target 仍供单条用例使用。
 */
function fakeDeps(
  options: {
    target?: UserRecord | null;
    targets?: Record<number, UserRecord>;
    activeAdmins?: number;
  } = {},
): { deps: AdminUserDeps; calls: string[] } {
  const calls: string[] = [];
  const deps = {
    users: {
      findById: async (id: number) => options.targets?.[id] ?? options.target ?? null,
      update: async (id: number, patch: UserPatch) => {
        const merged = { ...(options.targets?.[id] ?? (options.target as UserRecord)), id };
        if (patch.role !== undefined) merged.role = patch.role;
        if (patch.status !== undefined) merged.status = patch.status;
        return merged;
      },
      remove: async () => {
        calls.push('users');
        return true;
      },
      countActiveAdmins: async () => options.activeAdmins ?? 2,
    },
    sessions: {
      removeAllByUser: async () => {
        calls.push('sessions');
      },
    },
    conversations: {
      removeAllByUser: async () => {
        calls.push('conversations');
      },
    },
    files: {
      removeAllByUser: async () => {
        calls.push('files');
      },
    },
  } as unknown as { users: UserStore } & AdminUserDeps;
  return { deps, calls };
}

describe('变更用户', () => {
  it('目标用户不存在时返回 not-found', async () => {
    const { deps } = fakeDeps({ target: null });

    await expect(updateUser(deps, OTHER, { status: 'banned' }, ACTOR)).resolves.toEqual({
      status: 'not-found',
    });
  });

  it('管理员不能停用自己，否则会立刻失去后台入口', async () => {
    const { deps } = fakeDeps({ target: userRecord({ id: SELF, role: 'admin' }) });

    await expect(updateUser(deps, SELF, { status: 'banned' }, ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '不能停用或降级当前登录账号',
    });
  });

  it('管理员不能把自己降级为普通用户', async () => {
    const { deps } = fakeDeps({ target: userRecord({ id: SELF, role: 'admin' }) });

    await expect(updateUser(deps, SELF, { role: 'user' }, ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '不能停用或降级当前登录账号',
    });
  });

  it('降级最后一名管理员会被拒绝，保留后台入口', async () => {
    const { deps } = fakeDeps({ target: userRecord({ role: 'admin' }), activeAdmins: 1 });

    await expect(updateUser(deps, OTHER, { role: 'user' }, ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '至少保留一个可登录的管理员账号',
    });
  });

  it('停用最后一名管理员同样被拒绝：只拦降级的话，逐个停用就能让后台无人可进', async () => {
    const { deps } = fakeDeps({ target: userRecord({ role: 'admin' }), activeAdmins: 1 });

    await expect(updateUser(deps, OTHER, { status: 'banned' }, ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '至少保留一个可登录的管理员账号',
    });
  });

  it('还有其他管理员时允许降级', async () => {
    const { deps } = fakeDeps({ target: userRecord({ role: 'admin' }), activeAdmins: 2 });

    const result = await updateUser(deps, OTHER, { role: 'user' }, ACTOR);

    expect(result).toEqual({ status: 'ok', value: userRecord({ role: 'user' }) });
  });

  it('还有其他管理员时允许停用', async () => {
    const { deps } = fakeDeps({ target: userRecord({ role: 'admin' }), activeAdmins: 2 });

    const result = await updateUser(deps, OTHER, { status: 'banned' }, ACTOR);

    expect(result).toEqual({
      status: 'ok',
      value: userRecord({ role: 'admin', status: 'banned' }),
    });
  });

  it('变更成功时回传变更后的用户', async () => {
    const { deps } = fakeDeps({ target: userRecord() });

    await expect(updateUser(deps, OTHER, { status: 'banned' }, ACTOR)).resolves.toEqual({
      status: 'ok',
      value: userRecord({ status: 'banned' }),
    });
  });
});

describe('删除用户', () => {
  it('目标用户不存在时返回 not-found', async () => {
    const { deps } = fakeDeps({ target: null });

    await expect(removeUser(deps, OTHER, ACTOR)).resolves.toEqual({ status: 'not-found' });
  });

  it('不能删除当前登录账号', async () => {
    const { deps } = fakeDeps({ target: userRecord({ id: SELF }) });

    await expect(removeUser(deps, SELF, ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '不能删除当前登录账号',
    });
  });

  it('删除最后一名管理员会被拒绝', async () => {
    const { deps } = fakeDeps({ target: userRecord({ role: 'admin' }), activeAdmins: 1 });

    await expect(removeUser(deps, OTHER, ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '至少保留一个可登录的管理员账号',
    });
  });

  it('删除成功时先清会话、对话与文件，最后才删账号', async () => {
    const { deps, calls } = fakeDeps({ target: userRecord() });

    await expect(removeUser(deps, OTHER, ACTOR)).resolves.toEqual({
      status: 'ok',
      value: undefined,
    });
    expect(calls).toEqual(['sessions', 'conversations', 'files', 'users']);
  });
});

describe('批量变更用户状态', () => {
  it('勾选里含当前登录账号时整批拒绝', async () => {
    const { deps } = fakeDeps({
      targets: { [SELF]: userRecord({ id: SELF, role: 'admin' }), [OTHER]: userRecord() },
      activeAdmins: 3,
    });

    await expect(updateUsersStatus(deps, [SELF, OTHER], 'banned', ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '不能停用或降级当前登录账号',
    });
  });

  it('一次停用两名管理员会让后台无人可进，必须整批拒绝', async () => {
    // 逐个判定时每条都还能看到「还剩一名可登录」而各自放行，这正是名额要按整批算的原因
    const { deps } = fakeDeps({
      targets: {
        [OTHER]: userRecord({ id: OTHER, role: 'admin' }),
        3: userRecord({ id: 3, role: 'admin' }),
      },
      activeAdmins: 2,
    });

    await expect(updateUsersStatus(deps, [OTHER, 3], 'banned', ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '至少保留一个可登录的管理员账号',
    });
  });

  it('停用后仍有可登录管理员时整批放行，并回传变更条数', async () => {
    const { deps } = fakeDeps({
      targets: { [OTHER]: userRecord({ id: OTHER, role: 'admin' }), 3: userRecord({ id: 3 }) },
      activeAdmins: 2,
    });

    await expect(updateUsersStatus(deps, [OTHER, 3], 'banned', ACTOR)).resolves.toEqual({
      status: 'ok',
      value: 2,
    });
  });

  it('启用不消耗管理员名额，故不触发名额判定', async () => {
    const { deps } = fakeDeps({
      targets: { [OTHER]: userRecord({ id: OTHER, role: 'admin', status: 'banned' }) },
      activeAdmins: 0,
    });

    await expect(updateUsersStatus(deps, [OTHER], 'active', ACTOR)).resolves.toEqual({
      status: 'ok',
      value: 1,
    });
  });

  it('任一目标不存在时整批返回 not-found', async () => {
    const { deps } = fakeDeps({ targets: { [OTHER]: userRecord() } });

    await expect(updateUsersStatus(deps, [OTHER, 99], 'banned', ACTOR)).resolves.toEqual({
      status: 'not-found',
    });
  });

  it('批次全是普通用户时不占名额：库里一名可登录管理员都没有也照样放行', async () => {
    const { deps } = fakeDeps({ targets: { [OTHER]: userRecord() }, activeAdmins: 0 });

    await expect(updateUsersStatus(deps, [OTHER], 'banned', ACTOR)).resolves.toEqual({
      status: 'ok',
      value: 1,
    });
  });
});

describe('批量删除用户', () => {
  it('批次全是普通用户时不占名额：库里一名可登录管理员都没有也照样放行', async () => {
    const { deps } = fakeDeps({ targets: { [OTHER]: userRecord() }, activeAdmins: 0 });

    await expect(removeUsers(deps, [OTHER], ACTOR)).resolves.toEqual({
      status: 'ok',
      value: undefined,
    });
  });

  it('勾选里含当前登录账号时整批拒绝', async () => {
    const { deps } = fakeDeps({
      targets: { [SELF]: userRecord({ id: SELF, role: 'admin' }), [OTHER]: userRecord() },
      activeAdmins: 3,
    });

    await expect(removeUsers(deps, [SELF, OTHER], ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '不能删除当前登录账号',
    });
  });

  it('整批删完管理员归零时拒绝', async () => {
    const { deps } = fakeDeps({
      targets: {
        [OTHER]: userRecord({ id: OTHER, role: 'admin' }),
        3: userRecord({ id: 3, role: 'admin' }),
      },
      activeAdmins: 2,
    });

    await expect(removeUsers(deps, [OTHER, 3], ACTOR)).resolves.toEqual({
      status: 'rejected',
      message: '至少保留一个可登录的管理员账号',
    });
  });

  it('普通用户整批可删，逐个清理从属数据后再删账号', async () => {
    const { deps, calls } = fakeDeps({
      targets: { [OTHER]: userRecord(), 3: userRecord({ id: 3 }) },
    });

    await expect(removeUsers(deps, [OTHER, 3], ACTOR)).resolves.toEqual({
      status: 'ok',
      value: undefined,
    });
    expect(calls).toEqual([
      'sessions',
      'conversations',
      'files',
      'users',
      'sessions',
      'conversations',
      'files',
      'users',
    ]);
  });

  it('任一目标不存在时整批返回 not-found，且不产生任何清理动作', async () => {
    const { deps, calls } = fakeDeps({ targets: { [OTHER]: userRecord() } });

    await expect(removeUsers(deps, [OTHER, 99], ACTOR)).resolves.toEqual({ status: 'not-found' });
    expect(calls).toEqual([]);
  });
});
