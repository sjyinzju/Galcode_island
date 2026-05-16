// 永远通过的审核——开发期和"用户自部署不接三方"场景用。

export async function moderateStub(_filePath, _meta) {
  return { verdict: "stub_pass", approved: true };
}
