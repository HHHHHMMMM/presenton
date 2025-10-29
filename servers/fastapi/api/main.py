from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles  # 添加这行
from pathlib import Path  # 添加这行
from api.lifespan import app_lifespan
from api.middlewares import UserConfigEnvUpdateMiddleware
from api.v1.ppt.router import API_V1_PPT_ROUTER
from api.v1.webhook.router import API_V1_WEBHOOK_ROUTER
from api.v1.mock.router import API_V1_MOCK_ROUTER


app = FastAPI(lifespan=app_lifespan)


# Routers
app.include_router(API_V1_PPT_ROUTER)
app.include_router(API_V1_WEBHOOK_ROUTER)
app.include_router(API_V1_MOCK_ROUTER)


BASE_DIR = Path(__file__).resolve().parent.parent
static_path = BASE_DIR / "static"

print(f"📁 Static directory path: {static_path}")
print(f"✓ Static directory exists: {static_path.exists()}")

if static_path.exists():
    app.mount("/static", StaticFiles(directory=str(static_path)), name="static")
    print("✓ Static files mounted at /static")
else:
    print(f"⚠️  Warning: Static directory not found at {static_path}")
# === 静态文件挂载结束 ===

for route in app.routes:
    print(f"{route.methods if hasattr(route, 'methods') else 'N/A'} {route.path}")

# Middlewares
origins = ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(UserConfigEnvUpdateMiddleware)