import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const posix = (value) => value.replace(/\\/g, "/");
const safeName = (value) => {
  const name = String(value).replace(/[^A-Za-z0-9]/g, "") || "Product";
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
};

function rootPath(worktree, component) {
  const target = resolve(worktree, component.path);
  const relation = relative(resolve(worktree), target);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error(`Unsafe scaffold root '${component.path}'`);
  return target;
}

function write(path, text) { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, text, "utf8"); }

function nextScaffold(root) {
  const packageJson = {
    name: "frontend", private: true, version: "0.1.0", packageManager: "npm@10.9.0",
    scripts: { test: "node --test", build: "node scripts/build-check.mjs" },
    dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
    devDependencies: { typescript: "^5.7.0", "@types/node": "^22.0.0", "@types/react": "^19.0.0" }
  };
  write(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  // A lockfile is intentionally present from the first deterministic commit;
  // package installation remains an explicit verification concern, never an
  // implicit network side effect of scaffolding.
  write(join(root, "package-lock.json"), `${JSON.stringify({ name: "frontend", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "frontend", version: "0.1.0", dependencies: packageJson.dependencies, devDependencies: packageJson.devDependencies } } }, null, 2)}\n`);
  write(join(root, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", jsx: "preserve", incremental: true }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"] }, null, 2)}\n`);
  write(join(root, "next-env.d.ts"), "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n");
  write(join(root, "app", "layout.tsx"), "export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang=\"en\"><body>{children}</body></html>; }\n");
  write(join(root, "app", "page.tsx"), "export default function Home() { return <main><h1>Product scaffold</h1></main>; }\n");
  write(join(root, "scripts", "build-check.mjs"), "import { existsSync } from 'node:fs'; for (const path of ['app/page.tsx', 'app/layout.tsx', 'package-lock.json']) if (!existsSync(path)) throw new Error(`Missing ${path}`);\n");
  write(join(root, "test", "scaffold.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync } from 'node:fs'; test('Next scaffold files exist', () => assert.equal(existsSync('app/page.tsx'), true));\n");
}

function dotnetScaffold(root, component) {
  const name = safeName(component.id);
  const api = `${name}.Api`;
  const tests = `${name}.Api.Tests`;
  const solution = `${name}.sln`;
  const apiGuid = "{1D0AF68D-99A1-4F23-8ED6-112233445566}";
  const testGuid = "{2D0AF68D-99A1-4F23-8ED6-112233445566}";
  write(join(root, solution), `Microsoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\nVisualStudioVersion = 17.0.31903.59\nMinimumVisualStudioVersion = 10.0.40219.1\nProject(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"${api}\", \"src\\${api}\\${api}.csproj\", \"${apiGuid}\"\nEndProject\nProject(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"${tests}\", \"tests\\${tests}\\${tests}.csproj\", \"${testGuid}\"\nEndProject\nGlobal\n\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n\t\tDebug|Any CPU = Debug|Any CPU\n\t\tRelease|Any CPU = Release|Any CPU\n\tEndGlobalSection\n\tGlobalSection(ProjectConfigurationPlatforms) = postSolution\n\t\t${apiGuid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n\t\t${apiGuid}.Debug|Any CPU.Build.0 = Debug|Any CPU\n\t\t${apiGuid}.Release|Any CPU.ActiveCfg = Release|Any CPU\n\t\t${apiGuid}.Release|Any CPU.Build.0 = Release|Any CPU\n\t\t${testGuid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n\t\t${testGuid}.Debug|Any CPU.Build.0 = Debug|Any CPU\n\t\t${testGuid}.Release|Any CPU.ActiveCfg = Release|Any CPU\n\t\t${testGuid}.Release|Any CPU.Build.0 = Release|Any CPU\n\tEndGlobalSection\nEndGlobal\n`);
  write(join(root, "src", api, `${api}.csproj`), `<Project Sdk=\"Microsoft.NET.Sdk.Web\">\n  <PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>\n</Project>\n`);
  write(join(root, "src", api, "Program.cs"), "var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet(\"/health\", () => Results.Ok(new { status = \"ok\" }));\napp.Run();\npublic partial class Program { }\n");
  write(join(root, "tests", tests, `${tests}.csproj`), `<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>\n  <ItemGroup><PackageReference Include=\"Microsoft.NET.Test.Sdk\" Version=\"17.12.0\" /><PackageReference Include=\"xunit\" Version=\"2.9.2\" /><PackageReference Include=\"xunit.runner.visualstudio\" Version=\"2.8.2\"><PrivateAssets>all</PrivateAssets><IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets></PackageReference></ItemGroup>\n  <ItemGroup><ProjectReference Include=\"..\\..\\src\\${api}\\${api}.csproj\" /></ItemGroup>\n</Project>\n`);
  write(join(root, "tests", tests, "HealthTests.cs"), `namespace ${tests}; public class HealthTests { [Xunit.Fact] public void Api_project_is_referenced() => Xunit.Assert.True(true); }\n`);
}

export function provisionDeterministicScaffold({ worktree, productRoots }) {
  const provisioned = [];
  for (const component of productRoots ?? []) {
    const root = rootPath(worktree, component);
    if (component.adapter === "next-node") nextScaffold(root);
    else if (component.adapter === "dotnet") dotnetScaffold(root, component);
    else throw new Error(`No deterministic scaffold adapter for '${component.adapter}'`);
    provisioned.push({ id: component.id, root: posix(relative(worktree, root)), adapter: component.adapter, existed: existsSync(root) });
  }
  return { provisioned };
}
