import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// These intentionally inspect source structure; they do NOT compile C#, launch
// WPF, or establish runtime behavior. The separate C# harness tests real code.
test('[source assertion] API requires injected validated configuration, not a default server', async () => {
  const api = await read('client/ControlApiClient.cs');
  assert.match(api, /public ControlApiClient\(ClientConfiguration configuration\)/);
  assert.match(api, /_http\.BaseAddress = configuration\.ApiBaseUri;/);
  assert.doesNotMatch(api, /https?:\/\//);
  assert.doesNotMatch(api, /ControlApiClient\(\)/);
  assert.match(api, /CreateClient\(allowAutoRedirect: false\)/);
  assert.match(await read('client/ControlTransport.cs'), /AllowAutoRedirect = allowAutoRedirect/);
});

test('[source assertion] configuration boundary is local, explicit and non-WPF', async () => {
  const config = await read('client/ClientConfiguration.cs');
  assert.match(config, /CLOUDBRIDGE_API_BASE_URL/);
  assert.match(config, /private ClientConfiguration\(Uri apiBaseUri, string source\)/);
  assert.match(config, /if \(environmentValue is not null\) return Parse\(environmentValue,/);
  assert.match(config, /uri\.Scheme != Uri\.UriSchemeHttps/);
  assert.match(config, /entries\.Length != 1/);
  assert.match(config, /IOException or UnauthorizedAccessException/);
  assert.doesNotMatch(config, /HttpClient|SocketsHttpHandler|DeviceIdentity|System\.Windows|Process\.Start/);
  assert.equal(JSON.parse(await read('client/settings.example.json')).apiBaseUrl, 'https://api.example.invalid:8443/');
});

test('[source assertion] configuration failure exits before window and startup update work', async () => {
  const app = await read('client/App.xaml.cs');
  const config = app.indexOf('var result = ClientConfiguration.Load();');
  const gate = app.indexOf('if (!result.IsReady)', config);
  const shutdown = app.indexOf('Shutdown();', gate);
  const stop = app.indexOf('return;', shutdown);
  const window = app.indexOf('new MainWindow(result.Configuration!)');
  assert.ok(config >= 0 && gate > config && shutdown > gate && stop > shutdown && window > stop);
  assert.match(app.slice(gate, window), /MessageBox\.Show/);
  assert.doesNotMatch(await read('client/App.xaml'), /StartupUri/);
  const ui = await read('client/MainWindow.xaml.cs');
  assert.match(ui, /MainWindow\(ClientConfiguration configuration\)/);
  assert.match(ui, /_api = new ControlApiClient\(configuration\);/);
  assert.match(ui, /FooterText\.ToolTip = .*configuration\.Source/);
  assert.ok(ui.indexOf('服务地址已配置') < ui.indexOf('Loaded += async (_, _) => await HandleLoadedAsync();'));
});

test('[source assertion] updater and core inputs are required, never conditionally omitted', async () => {
  const project = await read('client/CloudBridge.Client.csproj');
  assert.match(project, /<Compile Remove="tests\\\*\*\\\*\.cs"/);
  assert.match(project, /Name="ValidateWindowsPackageInputs" BeforeTargets="PrepareForBuild"/);
  assert.match(project, /<Error Condition="!Exists\('\$\(CloudBridgeUpdaterPath\)'\)"/);
  const updater = project.match(/<Content Include="\$\(CloudBridgeUpdaterPath\)"[^>]+\/>/s)?.[0];
  assert.ok(updater);
  assert.doesNotMatch(updater, /Condition=/);
  assert.match(updater, /CopyToPublishDirectory="PreserveNewest"/);
  for (const name of ['sing-box.exe', 'geosite-cn.srs', 'geoip-cn.srs', 'LICENSE-sing-box-upstream.txt', 'COPYING-GPL-3.0.txt']) {
    assert.ok(project.includes(name), `Required input missing from project: ${name}`);
  }
});

test('[source assertion] Windows script preflights inputs and builds the updater before the client', async () => {
  const script = await read('scripts/build-windows.ps1');
  const updater = script.indexOf('& dotnet publish (Join-Path $repo \'updater\\CloudBridge.Updater.csproj\')');
  const client = script.indexOf('& dotnet publish (Join-Path $repo \'client\\CloudBridge.Client.csproj\')');
  assert.ok(updater > 0 && client > updater);
  assert.ok(script.indexOf('Missing or empty runtime dependency') < updater);
  assert.ok(script.indexOf('Rule-set hash mismatch') < updater);
  assert.ok(script.indexOf('CloudBridge.Configuration.Tests.csproj') < updater);
  assert.ok(script.indexOf('Push-Location -LiteralPath $repo') < script.indexOf('& dotnet --version'));
  assert.match(script, /\$sdkVersion\.Trim\(\) -ne '10\.0\.402'/);
  assert.match(script, /Pop-Location/);
  assert.match(script, /-p:CloudBridgeUpdaterPath=\$updater/);
  assert.match(script, /Output already exists/);
  assert.match(script, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Updater publish failed\.'/);
  assert.match(script, /LICENSE-sing-box-upstream\.txt/);
  assert.match(script, /COPYING-GPL-3\.0\.txt/);
  assert.doesNotMatch(script, /Invoke-WebRequest|Invoke-RestMethod|Start-Process|https?:\/\//);
});

test('[source assertion] original license and provenance notice bytes are preserved', async () => {
  const expected = {
    'client/LICENSE-sing-box.txt': '2013b81a3ee5cc9ad12eb31d6f3ac46fe3a924f4237178802195c725bb792659',
    'client/THIRD_PARTY_NOTICES.txt': '8aa85f317726571055b9529519800129bfb13a975ba51beb111f786a1648351f',
  };
  for (const [path, digest] of Object.entries(expected)) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  }
});

test('[source assertion] behavior harness links production code without device or package dependencies', async () => {
  const project = await read('client/tests/CloudBridge.Configuration.Tests.csproj');
  for (const name of ['ClientConfiguration.cs', 'ControlApiClient.cs', 'ControlTransport.cs', 'Models.cs']) {
    assert.ok(project.includes(`Link="${name}"`));
  }
  assert.doesNotMatch(project, /UseWPF|PackageReference|DeviceIdentity|ProxyService/);
  assert.match(await read('client/tests/Program.cs'), /sealed class RecordingHandler.*: HttpMessageHandler/);
});
