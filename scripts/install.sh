#!/bin/bash

# ============================================
# NAV - 个人导航页 一键安装脚本
# ============================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的信息
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 打印 Banner
print_banner() {
    echo -e "${BLUE}"
    cat << "EOF"
╔═══════════════════════════════════════════╗
║                                           ║
║   _   _   _   _   _   _   _   _   _       ║
║  / \ / \ / \ / \ / \ / \ / \ / \ / \      ║
║ ( N | A | V | - | P | a | g | e )         ║
║  \_/ \_/ \_/ \_/ \_/ \_/ \_/ \_/ \_/      ║
║                                           ║
║     轻量化 Notion 风格个人导航页           ║
║                                           ║
╚═══════════════════════════════════════════╝
EOF
    echo -e "${NC}"
}

# 检查命令是否存在
check_command() {
    if ! command -v $1 &> /dev/null; then
        return 1
    fi
    return 0
}

# 检测包管理器
detect_package_manager() {
    if check_command pnpm; then
        echo "pnpm"
    elif check_command npm; then
        echo "npm"
    elif check_command yarn; then
        echo "yarn"
    else
        echo ""
    fi
}

# 安装 Node.js (使用 nvm)
install_node() {
    info "正在安装 Node.js..."

    # 检查是否已安装 nvm
    if [ -d "$HOME/.nvm" ]; then
        info "检测到 nvm，正在安装最新 LTS 版本..."
        source "$HOME/.nvm/nvm.sh"
        nvm install --lts
        nvm use --lts
    else
        info "正在安装 nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

        # 加载 nvm
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

        nvm install --lts
        nvm use --lts
    fi

    success "Node.js 安装完成: $(node -v)"
}

# 安装 pnpm
install_pnpm() {
    if check_command pnpm; then
        success "pnpm 已安装: $(pnpm -v)"
        return
    fi

    info "正在安装 pnpm..."
    npm install -g pnpm
    success "pnpm 安装完成: $(pnpm -v)"
}

# 克隆项目
clone_project() {
    local target_dir=$1

    if [ -d "$target_dir" ]; then
        warn "目录 $target_dir 已存在"
        read -p "是否删除并重新安装？(y/N): " confirm
        if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
            rm -rf "$target_dir"
        else
            error "安装已取消"
        fi
    fi

    info "正在克隆项目..."
    git clone https://github.com/YOUR_USERNAME/nav-page.git "$target_dir"
    success "项目克隆完成"
}

# 安装依赖
install_dependencies() {
    local target_dir=$1

    info "正在安装依赖..."

    cd "$target_dir"

    # 安装 pnpm（如果需要）
    install_pnpm

    # 使用 pnpm 安装依赖
    pnpm install

    success "依赖安装完成"
}

# 配置环境变量
setup_env() {
    local target_dir=$1

    if [ ! -f "$target_dir/app/.env" ]; then
        info "正在创建环境配置..."

        cat > "$target_dir/app/.env" << EOF
# NAV 环境配置

# 应用标题
VITE_APP_TITLE=我的导航页

# AI 配置（可选）
# VITE_AI_PROVIDER=openai
# VITE_AI_API_KEY=your-api-key
# VITE_AI_BASE_URL=https://api.openai.com/v1
# VITE_AI_MODEL=gpt-4
EOF

        success "环境配置创建完成"
    fi
}

# 构建项目
build_project() {
    local target_dir=$1

    info "正在构建项目..."

    cd "$target_dir"
    pnpm build

    success "项目构建完成"
}

# 创建桌面快捷方式（可选）
create_desktop_shortcut() {
    local target_dir=$1

    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        read -p "是否创建桌面快捷方式？(y/N): " create_shortcut
        if [ "$create_shortcut" = "y" ] || [ "$create_shortcut" = "Y" ]; then
            cat > "$HOME/Desktop/NAV.desktop" << EOF
[Desktop Entry]
Name=NAV 导航页
Comment=Notion风格个人导航页
Exec=sh -c "cd $target_dir && pnpm dev"
Icon=$target_dir/app/public/icon.png
Terminal=true
Type=Application
Categories=Utility;
EOF
            chmod +x "$HOME/Desktop/NAV.desktop"
            success "桌面快捷方式创建完成"
        fi
    fi
}

# 显示完成信息
show_complete() {
    local target_dir=$1

    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════${NC}"
    echo -e "${GREEN}          🎉 安装完成！                    ${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════${NC}"
    echo ""
    echo -e "项目目录: ${BLUE}$target_dir${NC}"
    echo ""
    echo "快速开始:"
    echo ""
    echo -e "  ${YELLOW}cd $target_dir${NC}"
    echo -e "  ${YELLOW}pnpm dev${NC}          # 启动开发服务器"
    echo -e "  ${YELLOW}pnpm build${NC}        # 构建生产版本"
    echo -e "  ${YELLOW}pnpm preview${NC}      # 预览生产版本"
    echo ""
    echo "浏览器扩展:"
    echo ""
    echo -e "  1. 打开 Chrome -> 扩展程序 -> 开启开发者模式"
    echo -e "  2. 点击「加载已解压的扩展程序」"
    echo -e "  3. 选择 ${BLUE}$target_dir/extension${NC} 目录"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════${NC}"
}

# 主函数
main() {
    print_banner

    # 默认安装目录
    DEFAULT_DIR="$HOME/nav-page"

    # 解析参数
    TARGET_DIR="${1:-$DEFAULT_DIR}"

    info "安装目录: $TARGET_DIR"

    # 检查 Node.js
    if ! check_command node; then
        warn "未检测到 Node.js"
        install_node
    else
        info "Node.js 版本: $(node -v)"
    fi

    # 检查 npm
    if ! check_command npm; then
        error "未检测到 npm，请先安装 Node.js"
    fi

    # 检查 git
    if ! check_command git; then
        error "未检测到 git，请先安装 git"
    fi

    # 克隆项目
    clone_project "$TARGET_DIR"

    # 安装依赖
    install_dependencies "$TARGET_DIR"

    # 配置环境
    setup_env "$TARGET_DIR"

    # 询问是否构建
    read -p "是否立即构建项目？(Y/n): " build_now
    if [ "$build_now" != "n" ] && [ "$build_now" != "N" ]; then
        build_project "$TARGET_DIR"
    fi

    # 创建桌面快捷方式
    create_desktop_shortcut "$TARGET_DIR"

    # 显示完成信息
    show_complete "$TARGET_DIR"
}

# 运行主函数
main "$@"
