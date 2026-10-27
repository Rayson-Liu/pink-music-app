exports.default = async function notarizing(context) {
  const { electronPlatformName } = context;
  if (electronPlatformName !== 'darwin') {
    return;
  }
};
