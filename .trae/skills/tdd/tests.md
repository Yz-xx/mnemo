# 好测试与坏测试

## 好测试

**集成风格**：通过真实接口测试，而不是对内部部件的 mock。

```typescript
// GOOD: Tests observable behavior
test('user can checkout with valid cart', async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe('confirmed');
});
```

特征：

- 测试用户/调用者关心的行为
- 只使用公共 API
- 经受得住内部重构
- 描述是什么（WHAT），而不是怎么做（HOW）
- 每个测试一个逻辑断言

## 坏测试

**实现细节测试**：与内部结构耦合。

```typescript
// BAD: Tests implementation details
test('checkout calls paymentService.process', async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

危险信号：

- mock 内部协作者
- 测试私有方法
- 对调用次数/顺序做断言
- 重构而行为未变时测试却坏了
- 测试名称描述怎么做（HOW）而不是是什么（WHAT）
- 通过外部手段而不是接口来验证

```typescript
// BAD: Bypasses interface to verify
test('createUser saves to database', async () => {
  await createUser({ name: 'Alice' });
  const row = await db.query('SELECT * FROM users WHERE name = ?', ['Alice']);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test('createUser makes user retrievable', async () => {
  const user = await createUser({ name: 'Alice' });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe('Alice');
});
```

**同义反复的测试**：期望值重述了实现，所以测试凭构造就通过。

```typescript
// BAD: Expected value is recomputed the way the code computes it
test('calculateTotal sums line items', () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: Expected value is an independent, known literal
test('calculateTotal sums line items', () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```
