#include "box2d/box2d.h"
#include <cmath>
#include <limits>
#include <vector>
#include <array>
#include <cstdint>

constexpr float kStoneRadius = 0.145f;
static constexpr ::uint8_t kStoneMax = 16;
static constexpr ::uint8_t kMDStoneMax = 12;
constexpr float kStoneMass = 19.96f; // kg
constexpr float kPi = 3.14159265359f;
constexpr float cw = -kPi / 2.f;
constexpr float ccw = kPi / 2.f;
constexpr float y_lower_limit = 32.004f;
constexpr float y_upper_limit = 40.234f;
constexpr float x_upper_limit = 2.375f;
constexpr float x_lower_limit = -2.375f;
constexpr float stone_x_upper_limit = x_upper_limit - kStoneRadius;
constexpr float stone_x_lower_limit = x_lower_limit + kStoneRadius;
constexpr float stone_y_upper_limit = y_upper_limit + kStoneRadius;
constexpr float stone_y_lower_limit = y_lower_limit + kStoneRadius;
constexpr float tee_line = 38.405f;
constexpr float house_radius = 1.829f;
constexpr float house_touch_radius = house_radius + kStoneRadius;
constexpr float EPSILON = std::numeric_limits<float>::epsilon();
constexpr size_t num_teams = 2;
constexpr size_t stones_per_team = 8;
constexpr size_t num_coordinates = 2;

struct Velocity
{
    b2Vec2 vel;
};

struct StonePosition
{
    int id;
    float x;
    float y;
};

namespace digitalcurling3
{
    struct Vector2
    {
        float x; ///< x座標
        float y; ///< y座標

        constexpr Vector2() : x(0.f), y(0.f) {}
        constexpr Vector2(float x, float y) : x(x), y(y) {}

        constexpr Vector2 &operator+=(Vector2 v)
        {
            x += v.x;
            y += v.y;
            return *this;
        }

        constexpr Vector2 &operator-=(Vector2 v)
        {
            x -= v.x;
            y -= v.y;
            return *this;
        }

        constexpr Vector2 &operator*=(float f)
        {
            x *= f;
            y *= f;
            return *this;
        }

        constexpr Vector2 &operator/=(float f)
        {
            x /= f;
            y /= f;
            return *this;
        }

        float Length() const
        {
            return std::hypot(x, y);
        }
    };

    constexpr Vector2 operator-(Vector2 v)
    {
        return {-v.x, -v.y};
    }

    constexpr Vector2 operator+(Vector2 v1, Vector2 v2)
    {
        return {v1.x + v2.x, v1.y + v2.y};
    }

    constexpr Vector2 operator-(Vector2 v1, Vector2 v2)
    {
        return {v1.x - v2.x, v1.y - v2.y};
    }

    constexpr Vector2 operator*(float f, Vector2 v)
    {
        return {f * v.x, f * v.y};
    }

    constexpr Vector2 operator*(Vector2 v, float f)
    {
        return f * v;
    }

    constexpr Vector2 operator/(Vector2 v, float f)
    {
        return {v.x / f, v.y / f};
    }

    inline b2Vec2 ToB2Vec2(Vector2 v)
    {
        return {v.x, v.y};
    }

    inline Vector2 ToDC2Vector2(b2Vec2 v)
    {
        return {v.x, v.y};
    }
}

namespace digitalcurling3
{
    struct Transform
    {
        Vector2 position;
        float angle;

        constexpr Transform() : position(), angle(0.f) {}
        constexpr Transform(Vector2 position, float angle) : position(position), angle(angle) {}
    };
}

namespace digitalcurling3
{
    struct StoneData
    {
        Vector2 position;
        StoneData() {}
        StoneData(const Vector2 &pos) : position(pos) {}
    };
}

namespace digitalcurling3
{
    struct StoneDataVector
    {
        std::vector<digitalcurling3::StoneData> stones;
    };
}

namespace digitalcurling3
{
    struct FiveLockWithID
    {
        unsigned int flag;
        int16_t id;
    };
}

namespace digitalcurling3
{
    struct Collision
    {
        struct Stone
        {
            std::uint8_t id;
            Transform transform;

            Stone() : id(0), transform() {}
            Stone(std::uint8_t id, Transform const &transform) : id(id), transform(transform) {}
        };
        Stone a;
        Stone b;
        float normal_impulse;
        float tangent_impulse;
        Collision()
            : a(), b(), normal_impulse(0.f), tangent_impulse(0.f) {}
        Collision(std::uint8_t a_id, std::uint8_t b_id, Transform const &a_transform, Transform const &b_transform, float normal_impulse, float tangent_impulse)
            : a(a_id, a_transform), b(b_id, b_transform), normal_impulse(normal_impulse), tangent_impulse(tangent_impulse) {}

        Vector2 GetContactPoint() const
        {
            return (a.transform.position + b.transform.position) * 0.5f;
        }
    };
}

class StoneData
{
public:
    b2Body *body;
    std::vector<digitalcurling3::Collision> collisions;
};

class SimulatorFCV1
{
    friend struct SimulatorFCV1TestAccess;

public:
    explicit SimulatorFCV1(std::vector<digitalcurling3::StoneData> const &stones);
    class ContactListener : public b2ContactListener
    {
    public:
        ContactListener(SimulatorFCV1 *instance) : instance_(instance) {}
        virtual void PostSolve(b2Contact *contact, const b2ContactImpulse *impulse) override;
        void add_unique_id(std::vector<int> &list, int id);

    private:
        SimulatorFCV1 *const instance_;
    };
    bool is_freeguardzone(b2Body *body);
    bool is_removed_from_play(int stone_id) const;
    void restore_pre_shot_state();
    void freeguardzone_checker();
    void change_shot(int shot);
    void is_in_playarea();
    bool on_center_line(b2Body *body);
    void no_tick_checker();
    void no_tick_rule();
    void modified_fgz_checker();
    void modified_fgz_rule();
    std::vector<std::vector<StonePosition>> step(float seconds_per_frame);
    void set_stones();
    void set_velocity(float velocity_x, float velocity_y, float angular_velocity, unsigned int shot_per_team, unsigned int team_id, unsigned int applied_rule);
    digitalcurling3::StoneDataVector get_stones();

private:
    ContactListener contact_listener_;
    std::vector<digitalcurling3::StoneData> const &stones;
    unsigned int applied_rule; // 0: five-rock, 1: five-rock + no-tick, 2: mixed doubles
    int shot_per_team;
    int total_shot;
    unsigned int delivering_team_id;
    std::vector<int> is_awake;
    std::vector<int> moved;
    std::vector<int> is_no_tick;
    std::vector<int> in_free_guard_zone;
    std::vector<int> protected_stones_modified_fgz;
    std::vector<StonePosition> trajectory;
    std::vector<std::vector<StonePosition>> trajectory_list;
    digitalcurling3::FiveLockWithID five_lock_with_id;
    int delivered_stone_id;
    bool free_guard_zone;
    b2World world;
    b2BodyDef stone_body_def;
    std::array<b2Body *, static_cast<std::size_t>(kStoneMax)> stone_bodies;
};
